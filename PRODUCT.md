# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Anyone who runs pi. The reader this product is designed for first has pi on a
machine of their own: a workstation, a home server, or a remote host. They want
to see and steer that session while they are away from it, usually from a phone.
They installed pi themselves, so a session, a model, and a tool call take no
explanation; pie explains none of them.

The same person opens pie on a desktop next to the machine that runs pi. That
window is the same product, not a second one.

## Product Purpose

Pie is the window onto a pi session that runs on another machine. It reaches the
machine — pi on the local machine, taken from `PATH`, or a host over SSH — lists
the sessions pi left there, opens one, and shows the conversation as pi writes
it: what the user asked, what the model answered, which tools ran, and what they
printed. From the same window the user answers pi with the next message, images,
pi's own slash commands, the model, and the thinking level.

Pie exists because pi runs where the work is, and the person is not always
there. Success is a reader on a phone who sees what pi is doing, understands it,
and gives the next instruction — without a terminal, and without a trip back to
the desk.

## Positioning

Reach plus a phone-first window. Pie drives a pi process on a machine it reaches
over SSH, and it is designed for a 360–430px screen before it is designed for a
desktop. A GUI that only wraps a pi running beside it cannot make the same
claim.

## Operating Context

- The user runs pi on a machine of their own and leaves it there. The link from
  the phone to that machine is the user's own SSH reach, over the network they
  already have.
- Pi must already be installed on that machine, on `PATH`, at the release pie
  speaks. `pi --version` must answer with a value pie accepts.
- Provider credentials, the model list, extensions, skills, themes, and session
  files all belong to pi on that machine. Pie hands pi no credential and keeps
  no model, no state, and no session store of its own.
- A conversation is a file that pi writes in its agent directory — by default
  `~/.pi/agent/sessions`, or where `PI_CODING_AGENT_DIR` or
  `PI_CODING_AGENT_SESSION_DIR` point. Pie reads those files where they are.

## Capabilities and Constraints

Pie connects to one machine at a time: pi on this machine, or a host over SSH
with a password or a private key. It shows the sessions of that machine, opens
one, follows the conversation while pi writes it, and takes the next message —
text, images, pi's own slash commands, a bash line, the model, and the thinking
level. A run can be stopped.

- Pi is the authority. Pie speaks pi's RPC mode (`pi --mode rpc`, JSONL over
  stdio) and mirrors its protocol. A record pie does not know degrades to a
  general shape; it never ends the connection.
- The host must have pi installed. Pie's version names the release of pi it
  speaks; a machine that runs another release is not refused. Pie connects and
  writes a warning to the log, because a record it does not know degrades to a
  general shape. Pie installs nothing and updates nothing, and the window
  carries no word about the release it found.
- SSH passwords, keys, and passphrases stay in memory for the handshake. Pie
  writes no credential to disk, and it writes no file on the host.
- A host key pie has not seen is confirmed by the user before the handshake goes
  on. Pie keeps its own `known_hosts` and also accepts an entry from the user's
  own file.
- One pi process serves a connection today. Several sessions at once on one
  machine is a known gap, not a decision against it.
- Pie reads the session files over the local filesystem or over SFTP. It starts
  no pi only to show a list.
- iOS is out of scope. Design work covers desktop and Android.

## Brand Commitments

- The name `pie` is fixed. No logo, domain, or site exists yet; the only icon in
  the tree is the framework's default.
- The voice on screen today follows pi's own: "There are many agent harnesses,
  but this one is yours." That line is not fixed; a later round may replace it.

## Evidence on Hand

None. There is no site, no screenshot, no demo recording, no user quote, no test
report, and no benchmark. The only material that exists is the application
itself, and the component preview (Storybook) that draws components from fixed
arguments. A later round must not invent a screenshot, a quote, a user count, or
a result.

## Product Principles

1. Reach is the product. The machine that runs pi is usually not the machine in
   the user's hand, so every screen must work over a link that can be slow,
   metered, or lost, and must survive a link that drops.
2. The phone leads. Lay out for 360–430px first; the desktop window spreads the
   same tree and never forks it.
3. Pi stays the authority. Pie shows what pi says and sends what pi accepts. It
   does not repeat pi's work, and it does not hide what it cannot read.
4. The machine and its secrets stay the user's. Pie holds no credential after
   the handshake, writes nothing on the host, and reads only the files it must.
5. The window is honest. A run shows what happened while it happens, a failure
   is marked as a failure, and nothing is invented to fill a gap.

## Accessibility & Inclusion

WCAG 2.2 AA where the platform permits it: contrast, focus, keyboard reach,
reduced motion, and a name for every control. The Android system bars carry the
same weight — no content sits under them, on any screen.
