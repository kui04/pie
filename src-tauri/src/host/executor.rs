//! The programs a machine runs, and the shell line one becomes.

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::time::Duration;

use anyhow::{Context as _, ensure};
use bytes::Bytes;
use enum_dispatch::enum_dispatch;

use crate::channel::{Channel, ExitStatus, Process};

/// How long a one-shot command has to answer.
///
/// The commands pie captures whole are small checks - a version probe, a path
/// test, a directory read - so half a minute is generous. The bound is the
/// promise that the call returns whatever the command does.
pub(crate) const OUTPUT_TIMEOUT: Duration = Duration::from_secs(30);

/// One program to run on a machine.
#[derive(Debug, Clone, Default)]
pub struct Command {
    /// The program to run, as the machine names it.
    pub program: String,
    /// Its arguments, in order.
    pub args: Vec<String>,
    /// The directory it starts in, as the machine writes it.
    pub cwd: Option<String>,
    /// The environment it reads, beside the one it inherits.
    pub env: BTreeMap<String, String>,
}

impl Command {
    /// Prepares to run `program` with no argument.
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
        }
    }

    /// Appends one argument.
    pub fn with_arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Appends arguments, in the order the program reads them.
    pub fn with_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Starts the program in this directory.
    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Adds one environment entry for the program.
    #[cfg(test)]
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    /// The line the shell of `family` runs for this command.
    ///
    /// The family decides the shape, so the caller never chooses a quoting rule by
    /// hand and a machine of another system never reads a line of the wrong shell.
    pub fn into_shell_line(self, family: OsFamily) -> anyhow::Result<String> {
        match family {
            OsFamily::Unix => self.posix_line(),
            OsFamily::Windows => self.windows_line(),
        }
    }

    /// The line a POSIX shell runs for this command.
    ///
    /// Shape: `cd <dir> && NAME=value ... 'program' arg ...`
    ///
    /// Every word is quoted by `shlex`. The line is meant for non-interactive
    /// use (`sh -c`, an SSH exec request); control characters are not quoted
    /// (they cannot be, portably), so never type it into an interactive
    /// terminal.
    fn posix_line(self) -> anyhow::Result<String> {
        ensure!(!self.program.is_empty(), "the program name is empty");

        let mut line = String::new();

        if let Some(cwd) = &self.cwd {
            ensure!(!cwd.is_empty(), "the working directory is empty");
            // Anchor relative paths: a bare `-x` would be read by `cd` as an
            // option, and a bare `x` is searched through `$CDPATH`, which can
            // print the directory to stdout.
            let anchored =
                if cwd.starts_with('/') || cwd.starts_with("./") || cwd.starts_with("../") {
                    cwd.clone()
                } else {
                    format!("./{cwd}")
                };
            line.push_str("cd ");
            line.push_str(&quote_posix("working directory", &anchored)?);
            line.push_str(" && "); // a failed `cd` must not run the program elsewhere
        }

        // Prefix assignments: pure POSIX, no dependency on an `env` binary.
        for (key, value) in &self.env {
            ensure!(
                is_posix_env_name(key),
                "{key:?} is not a valid environment variable name for a POSIX shell"
            );
            line.push_str(key);
            line.push('=');
            line.push_str(&quote_posix("environment value", value)?);
            line.push(' ');
        }

        line.push_str(&quote_posix_always("program", &self.program)?);
        for arg in &self.args {
            line.push(' ');
            line.push_str(&quote_posix("argument", arg)?);
        }
        Ok(line)
    }

    /// The line a Windows `cmd.exe` shell runs for this command.
    ///
    /// Shape: `cd /d ^"<dir>^" && set NAME=value&& "program" arg ...`, where
    /// every `cmd.exe` metacharacter outside the program path is `^`-escaped.
    ///
    /// When running it locally, hand it over with `raw_arg` (`.arg("/c").raw_arg(line)`);
    /// the standard `arg` would escape the quotes a second time.
    fn windows_line(self) -> anyhow::Result<String> {
        let program = windows_program_word(&self.program)?;
        let mut line = String::new();

        if let Some(cwd) = &self.cwd {
            ensure!(!cwd.is_empty(), "the working directory is empty");
            ensure!(
                !cwd.contains('"'),
                "the working directory contains a double quote, which no Windows path can: {cwd:?}"
            );
            ensure_cmd_representable("working directory", cwd)?;
            let cwd = cwd.replace('/', "\\");
            // `cd` is a builtin and re-reads its argument after `^` removal, so
            // it sees real quotes (spaces and `,;=` stay inside one path).
            line.push_str("cd /d ^\"");
            push_caret_escaped(&mut line, &cwd);
            line.push_str("^\" && ");
        }

        for (key, value) in &self.env {
            ensure!(
                is_windows_env_name(key),
                "{key:?} is not a supported environment variable name for cmd.exe"
            );
            ensure!(
                !value.is_empty(),
                "cmd.exe cannot set {key} to an empty string (`set {key}=` deletes it)"
            );
            ensure_cmd_representable("environment value", value)?;
            line.push_str("set ");
            push_caret_escaped(&mut line, key);
            line.push('=');
            push_caret_escaped(&mut line, value);
            // No space before `&&`, or it would become part of the value.
            line.push_str("&& ");
        }

        line.push_str(&program);
        for arg in &self.args {
            line.push(' ');
            line.push_str(&quote_windows_cmd_arg(arg)?);
        }

        // `cmd /c` strips the first and last `"` when the line starts with one,
        // which breaks `"C:\Program Files\x.exe" arg`. A leading `@` (echo
        // suppression, harmless here) means the line never starts with a quote.
        if line.starts_with('"') {
            line.insert(0, '@');
        }

        ensure!(
            line.encode_utf16().count() <= WINDOWS_CMD_MAX_LEN,
            "the command line is too long for cmd.exe"
        );
        Ok(line)
    }
}

/// cmd.exe's documented limit is 8191 UTF-16 units; the margin leaves room for
/// the `cmd.exe /c ` prefix the caller adds.
const WINDOWS_CMD_MAX_LEN: usize = 8000;

/// Quotes one argument for Windows CRT / `cmd.exe` command lines, rejecting NUL or newlines.
///
/// Two layers, in this order:
/// 1. CRT quoting (`CommandLineToArgvW` rules), so the child's argv is exact.
/// 2. `^`-escaping of every cmd.exe metacharacter, quotes included, so cmd.exe
///    never sees a quoted region (its quote state disagrees with the CRT's as
///    soon as an argument contains `"`). The carets are consumed by cmd.exe and
///    the child receives exactly the layer-1 string.
fn quote_windows_cmd_arg(arg: &str) -> anyhow::Result<String> {
    ensure_cmd_representable("argument", arg)?;

    fn is_safe(c: char) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\' | ':' | '@' | '+')
    }
    if !arg.is_empty() && arg.chars().all(is_safe) {
        return Ok(arg.to_owned());
    }

    let mut crt = String::with_capacity(arg.len() + 2);
    crt.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Backslashes before a quote double up, then the quote is escaped.
                crt.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                crt.push('"');
                backslashes = 0;
            }
            _ => {
                crt.extend(std::iter::repeat_n('\\', backslashes));
                crt.push(c);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote double up too.
    crt.extend(std::iter::repeat_n('\\', backslashes * 2));
    crt.push('"');

    let mut out = String::with_capacity(crt.len() + 8);
    push_caret_escaped(&mut out, &crt);
    Ok(out)
}

/// The program as cmd.exe's command token: bare if plain, else in plain quotes.
fn windows_program_word(program: &str) -> anyhow::Result<String> {
    ensure!(!program.is_empty(), "the program name is empty");
    ensure_cmd_representable("program", program)?;
    ensure!(
        !program.contains('"'),
        "program name contains a double quote: {program:?}"
    );
    ensure!(
        !program.contains('%'),
        "program name contains `%`, which cmd.exe expands even inside quotes: {program:?}"
    );
    // `/` would start a switch in an unquoted command token; Windows treats
    // both separators alike.
    let program = program.replace('/', "\\");
    let bare = program
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '\\' | ':' | '+'));
    Ok(if bare {
        program
    } else {
        format!("\"{program}\"")
    })
}

/// `^`-escapes `^ & | < > ( ) % ! "`. For `%` this works on a command line
/// because it makes the would-be variable name end in `^`, which never matches.
fn push_caret_escaped(out: &mut String, s: &str) {
    for c in s.chars() {
        if matches!(c, '^' | '&' | '|' | '<' | '>' | '(' | ')' | '%' | '!' | '"') {
            out.push('^');
        }
        out.push(c);
    }
}

fn is_windows_env_name(name: &str) -> bool {
    // Covers names like `ProgramFiles(x86)`; `=` and `/` are excluded on purpose.
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '(' | ')'))
}

fn ensure_cmd_representable(what: &str, s: &str) -> anyhow::Result<()> {
    ensure!(
        !s.contains(['\0', '\r', '\n']),
        "{what} contains NUL or a line break, which cmd.exe cannot carry: {s:?}"
    );
    Ok(())
}

/// Quotes one word for a POSIX shell. `shlex` leaves plain words bare and rejects NUL.
fn quote_posix(what: &str, s: &str) -> anyhow::Result<String> {
    let quoted = shlex::try_quote(s).with_context(|| format!("cannot quote {what} {s:?}"))?;
    Ok(quoted.into_owned())
}

/// Like `quote_posix`, but never bare. An unquoted `time`, `if` or `!` in command
/// position would be read as a reserved word, and a bare name can be alias-expanded.
fn quote_posix_always(what: &str, s: &str) -> anyhow::Result<String> {
    let quoted = quote_posix(what, s)?;
    // Unchanged means nothing in it needed quoting, so it has no `'` and wrapping is safe.
    Ok(if quoted == s {
        format!("'{s}'")
    } else {
        quoted
    })
}

fn is_posix_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// What a command printed, and how it ended.
#[derive(Debug, Clone)]
pub struct CommandOutput {
    /// What it wrote to its standard output.
    pub stdout: Bytes,
    /// What it wrote to its standard error.
    pub stderr: Bytes,
    /// How it ended.
    pub exit_status: ExitStatus,
}

/// The family of operating system a machine runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsFamily {
    /// Linux, macOS, Android, or another Unix.
    Unix,
    /// Windows.
    Windows,
}

impl OsFamily {
    /// The family this process runs on.
    ///
    /// A local machine is this process's own machine, so this answer covers it.
    pub(crate) fn of_this_process() -> Self {
        match std::env::consts::FAMILY {
            "windows" => Self::Windows,
            _ => Self::Unix,
        }
    }
}

/// Runs programs on a machine.
#[enum_dispatch]
pub trait Executor: Send + Sync + Debug {
    /// The family of operating system this machine runs.
    ///
    /// Asked instead of assumed: the machine pie reaches can run another system
    /// than the one pie was built for, and its commands are written in the shape
    /// its own shell reads.
    async fn family(&self) -> OsFamily;

    /// Starts `cmd`, and hands back its records and its life.
    async fn spawn(&self, cmd: Command) -> anyhow::Result<(Channel, Process)>;

    /// Runs `cmd` to its end, and captures what it printed.
    async fn exec(&self, cmd: Command) -> anyhow::Result<CommandOutput>;
}

#[cfg(test)]
mod windows_line_tests {
    use super::*;

    #[test]
    fn line_shape() {
        let line = Command::new(r"C:\Program Files\Git\bin\git.exe")
            .with_args(["log", "a b", r#"say "hi""#, "50%"])
            .with_cwd(r"C:\work dir")
            .with_env("FOO", "a&b")
            .into_shell_line(OsFamily::Windows)
            .unwrap();
        assert_eq!(
            line,
            r#"cd /d ^"C:\work dir^" && set FOO=a^&b&& "C:\Program Files\Git\bin\git.exe" log ^"a b^" ^"say \^"hi\^"^" ^"50^%^""#
        );
    }

    #[test]
    fn never_starts_with_a_quote() {
        let line = Command::new(r"C:\Program Files\x.exe")
            .into_shell_line(OsFamily::Windows)
            .unwrap();
        assert_eq!(line, r#"@"C:\Program Files\x.exe""#);
    }

    #[test]
    fn crt_backslash_rules() {
        // Backslashes only double up in front of a quote, or the closing quote.
        assert_eq!(quote_windows_cmd_arg(r"C:\dir\").unwrap(), r"C:\dir\");
        assert_eq!(quote_windows_cmd_arg(r"a b\").unwrap(), r#"^"a b\\^""#);
        assert_eq!(quote_windows_cmd_arg(r#"a\"b"#).unwrap(), r#"^"a\\\^"b^""#);
        assert_eq!(quote_windows_cmd_arg("").unwrap(), r#"^"^""#);
    }

    #[test]
    fn metacharacters_are_escaped() {
        assert_eq!(quote_windows_cmd_arg("a&b").unwrap(), r#"^"a^&b^""#);
        assert_eq!(quote_windows_cmd_arg("%PATH%").unwrap(), r#"^"^%PATH^%^""#);
        assert_eq!(
            quote_windows_cmd_arg("a|b>c<d").unwrap(),
            r#"^"a^|b^>c^<d^""#
        );
    }

    #[test]
    fn rejects_unrepresentable_input() {
        assert!(
            Command::new("x")
                .with_arg("a\nb")
                .into_shell_line(OsFamily::Windows)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_arg("a\0b")
                .into_shell_line(OsFamily::Windows)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_cwd("C:\\a\"b")
                .into_shell_line(OsFamily::Windows)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_env("K", "")
                .into_shell_line(OsFamily::Windows)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_env("A=B", "1")
                .into_shell_line(OsFamily::Windows)
                .is_err()
        );
        assert!(
            Command::new("100%.exe")
                .into_shell_line(OsFamily::Windows)
                .is_err()
        );
        assert!(Command::new("").into_shell_line(OsFamily::Windows).is_err());
        assert!(
            Command::new("x")
                .with_arg("a".repeat(9000))
                .into_shell_line(OsFamily::Windows)
                .is_err()
        );
    }
}

#[cfg(test)]
mod posix_shell_tests {
    use super::*;

    #[test]
    fn line_shape() {
        let line = Command::new("ls")
            .with_arg("-la")
            .with_cwd("src")
            .with_env("A", "b")
            .into_shell_line(OsFamily::Unix)
            .unwrap();
        assert!(line.starts_with("cd ./src && A=b 'ls' -la"), "{line}");
    }

    #[test]
    fn rejects_unrepresentable_input() {
        assert!(
            Command::new("x")
                .with_arg("a\0b")
                .into_shell_line(OsFamily::Unix)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_cwd("a\0b")
                .into_shell_line(OsFamily::Unix)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_env("A", "a\0b")
                .into_shell_line(OsFamily::Unix)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_env("A=B", "1")
                .into_shell_line(OsFamily::Unix)
                .is_err()
        );
        assert!(
            Command::new("x")
                .with_env("1A", "1")
                .into_shell_line(OsFamily::Unix)
                .is_err()
        );
        assert!(Command::new("").into_shell_line(OsFamily::Unix).is_err());
        assert!(
            Command::new("x")
                .with_cwd("")
                .into_shell_line(OsFamily::Unix)
                .is_err()
        );
    }
}

/// Runs the generated lines under every installed `sh`-family shell, so a quoting
/// rule that one shell reads differently shows up here. Missing shells are skipped.
#[cfg(all(test, unix))]
mod posix_real_shell_tests {
    use std::path::Path;
    use std::process::Output;

    use super::*;

    const AWKWARD: &[&str] = &[
        "", " ", "a b", "it's", "\"q\"", "$HOME", "`id`", r"a\b", "*", "?", "[a]", "-n", "~",
        "~root", "a\nb", "é", "!x", "^x", "a;b", "&&", "|", "<f", "=x", "a=b", "{a,b}", "#c", "%s",
        r"\0",
    ];

    const SHELLS: &[&[&str]] = &[
        &["sh"],
        &["dash"],
        &["bash"],
        &["zsh"],
        &["ksh"],
        &["busybox", "sh"],
    ];

    fn run_everywhere(line: &str, dir: Option<&Path>, mut check: impl FnMut(&str, Output)) {
        let mut ran = 0;
        for argv in SHELLS {
            let mut cmd = std::process::Command::new(argv[0]);
            cmd.args(&argv[1..]).arg("-c").arg(line);
            if let Some(dir) = dir {
                cmd.current_dir(dir);
            }
            match cmd.output() {
                Ok(out) => {
                    ran += 1;
                    check(&argv.join(" "), out);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => panic!("{}: {e}", argv.join(" ")),
            }
        }
        assert!(ran > 0, "no shell available to test against");
    }

    #[test]
    fn args_survive_every_installed_shell() {
        // The shell under test parses the quoted words once; a fixed inner `sh`
        // then prints each argument NUL-terminated. (ksh93's own `printf` treats
        // `\0` in a format differently, which would test printf, not the quoting.)
        let line = Command::new("sh")
            .with_args(["-c", r#"for a; do printf '%s\0' "$a"; done"#, "sh"])
            .with_args(AWKWARD.iter().copied())
            .into_shell_line(OsFamily::Unix)
            .unwrap();
        run_everywhere(&line, None, |shell, out| {
            assert!(
                out.status.success(),
                "{shell}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            let mut got: Vec<&[u8]> = out.stdout.split(|b| *b == 0).collect();
            got.pop(); // empty tail after the final NUL
            let want: Vec<&[u8]> = AWKWARD.iter().map(|a| a.as_bytes()).collect();
            assert_eq!(got, want, "{shell}: {line}");
        });
    }

    #[test]
    fn reserved_words_and_builtins_are_programs() {
        // Without quoting, `!` and `time` are shell syntax, not programs.
        for name in ["time", "if", "!", "[", "{"] {
            let line = Command::new(name).into_shell_line(OsFamily::Unix).unwrap();
            run_everywhere(&line, None, |shell, out| {
                assert!(
                    !out.status.success(),
                    "{shell}: `{name}` should be looked up as a program: {line}"
                );
            });
        }
    }

    #[test]
    fn env_and_absolute_cwd_survive_every_installed_shell() {
        let dir = std::env::temp_dir().join(format!(
            "pie dir with 'quote' and $x {}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let value = "a b'c\"d$e`f\\g\nh~ =i";
        let line = Command::new("sh")
            .with_args(["-c", r#"printf '%s\0' "$A" "$B"; pwd -P"#])
            .with_env("A", value)
            .with_env("B", "")
            .with_cwd(dir.to_str().unwrap())
            .into_shell_line(OsFamily::Unix)
            .unwrap();
        let want_pwd = dir.canonicalize().unwrap();
        run_everywhere(&line, None, |shell, out| {
            let mut parts = out.stdout.splitn(3, |b| *b == 0);
            assert_eq!(parts.next().unwrap(), value.as_bytes(), "{shell}");
            assert_eq!(parts.next().unwrap(), b"", "{shell}");
            let pwd = String::from_utf8(parts.next().unwrap().to_vec()).unwrap();
            assert_eq!(pwd.trim_end(), want_pwd.to_str().unwrap(), "{shell}");
        });
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn relative_cwd_is_anchored_against_options_and_cdpath() {
        let root = std::env::temp_dir().join(format!("pie-cwd-{}", std::process::id()));
        std::fs::create_dir_all(root.join("-dash dir")).unwrap();
        std::fs::create_dir_all(root.join("elsewhere/plain")).unwrap();
        std::fs::create_dir_all(root.join("plain")).unwrap();
        let want = root.join("plain").canonicalize().unwrap();

        // `-dash dir` must not be read as an option.
        let line = Command::new("pwd")
            .with_cwd("-dash dir")
            .into_shell_line(OsFamily::Unix)
            .unwrap();
        run_everywhere(&line, Some(&root), |shell, out| {
            assert!(
                out.status.success(),
                "{shell}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        });

        // `plain` must resolve against the current directory, not through $CDPATH.
        let line = format!(
            "CDPATH={} && export CDPATH && {}",
            shlex::try_quote(root.join("elsewhere").to_str().unwrap()).unwrap(),
            Command::new("pwd")
                .with_args(["-P"])
                .with_cwd("plain")
                .into_shell_line(OsFamily::Unix)
                .unwrap()
        );
        run_everywhere(&line, Some(&root), |shell, out| {
            assert_eq!(
                String::from_utf8_lossy(&out.stdout).trim_end(),
                want.to_str().unwrap(),
                "{shell}"
            );
        });

        // A missing directory must stop the program from running.
        let line = Command::new("echo")
            .with_arg("ran")
            .with_cwd("missing")
            .into_shell_line(OsFamily::Unix)
            .unwrap();
        run_everywhere(&line, Some(&root), |shell, out| {
            assert!(!out.status.success() && out.stdout.is_empty(), "{shell}");
        });
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]
mod shell_line_tests {
    use super::*;

    #[test]
    fn the_family_of_the_machine_decides_the_shape_of_the_line() {
        let posix = Command::new("ls").into_shell_line(OsFamily::Unix).unwrap();
        let windows = Command::new("ls")
            .into_shell_line(OsFamily::Windows)
            .unwrap();

        assert_eq!(posix, "'ls'");
        assert_eq!(windows, "ls");
    }
}
