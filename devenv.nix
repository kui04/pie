{
  pkgs,
  config,
  ...
}:

{
  # Anything in this shell opens the pinned Chromium, not the system default
  # browser — xdg-open prefers $BROWSER, and storybook opens through xdg-open.
  env.BROWSER = "chromium";

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
    pkgs.just
    pkgs.just-lsp
    pkgs.webkitgtk_4_1
  ];

  languages.rust = {
    enable = true;
    channel = "stable";
    mold.enable = true;
    targets = [
      "aarch64-linux-android"
      "armv7-linux-androideabi"
      "i686-linux-android"
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
        rustfmt = config.languages.rust.toolchainPackage;
      };
    };
  };
}
