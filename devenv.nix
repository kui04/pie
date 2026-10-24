{
  pkgs,
  config,
  inputs,
  ...
}:

let
  pkgsWithRust = pkgs.extend inputs.rust-overlay.overlays.default;
  nightlyRustfmt = pkgsWithRust.rust-bin.nightly.latest.rustfmt;
in
{
  # Anything in this shell opens the pinned Chromium, not the system default
  # browser — xdg-open prefers $BROWSER, and storybook opens through xdg-open.
  env.BROWSER = "chromium";

  # The file chooser of tauri-plugin-dialog is GTK3, and its
  # org.gtk.Settings.FileChooser schema is nested under the GTK3 gsettings
  # directory rather than exposed by XDG_DATA_DIRS. Without this, choosing an
  # attachment aborts pie with "Settings schema ... is not installed".
  env.GSETTINGS_SCHEMA_DIR = "${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}/glib-2.0/schemas";

  # Tauri 2 Linux desktop system dependencies
  # https://tauri.app/start/prerequisites/#linux
  packages = [
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.cairo
    pkgs.chromium
    pkgs.gdk-pixbuf
    pkgs.glib
    pkgs.gtk3
    pkgs.libayatana-appindicator
    pkgs.librsvg
    pkgs.xdotool
    pkgs.libsoup_3
    pkgs.openssl
    pkgs.pango
    pkgs.pkg-config
    pkgs.webkitgtk_4_1
    nightlyRustfmt
  ];

  languages.rust = {
    enable = true;
    channel = "stable";
    mold.enable = true;
    targets = [
      "aarch64-linux-android"
      "x86_64-linux-android"
    ];
  };

  languages.javascript = {
    enable = true;
    pnpm.enable = true;
  };

  android = {
    enable = true;
    # 36 matches current tauri android template's compileSdk; 35 kept for
    # plugins that hardcode the older platform.
    platforms.version = [
      "36"
      "35"
    ];
    # Exactly one build-tools version: the android module's aapt2 gradle
    # override uses the first entry, and mixing versions trips gradle's
    # version checks.
    buildTools.version = [ "36.0.0" ];
    ndk.enable = true;
    emulator.enable = false;
    systemImages.enable = false;
    googleAPIs.enable = false;
    googleTVAddOns.enable = false;
  };

  git-hooks.hooks = {
    nixfmt.enable = true;

    prettier = {
      enable = true;
      files = "\\.(css|html|json|md|ts|tsx|js|jsx)$";
      settings.binPath = "./node_modules/.bin/prettier";
    };

    eslint = {
      enable = true;
      settings = {
        binPath = "./node_modules/.bin/eslint";
        extensions = "\\.(js|jsx|ts|tsx)$";
      };
    };

    rustfmt = {
      enable = true;
      settings.manifest-path = "src-tauri/Cargo.toml";
      packageOverrides = {
        cargo = config.languages.rust.toolchainPackage;
        rustfmt = nightlyRustfmt;
      };
    };
  };

  # Expose MiniBrowser as a callable binary
  scripts.minibrowser = {
    exec = ''
      exec ${pkgs.webkitgtk_4_1}/libexec/webkit2gtk-4.1/MiniBrowser "$@"
    '';
    description = "Run the WebKitGTK MiniBrowser";
  };

  scripts.cargo-fmt.exec = ''
    exec ${nightlyRustfmt}/bin/cargo-fmt "$@"
  '';
  scripts.rustfmt.exec = ''
    exec ${nightlyRustfmt}/bin/rustfmt "$@"
  '';
}
