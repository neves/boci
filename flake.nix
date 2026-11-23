{
  description = "Fast Bun drop-in replacement for the OCI CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      version = "0.0.1";
      sources = {
        x86_64-linux = {
          asset = "boci-linux-x64";
          sha256 = "7af06751557a8d037eccdba3389963c879f8aa1f0619d9c5e36a608b71c19091";
        };
        aarch64-linux = {
          asset = "boci-linux-arm64";
          sha256 = "01d714bdf086c87aa122dc506299848fc3efacadc9c5a0912c478fcaf0c0d642";
        };
        x86_64-darwin = {
          asset = "boci-darwin-x64";
          sha256 = "05a950687dac97a42050561b813a100c2a9c5c77d2c8a6ee90ff6e3c68780a36";
        };
        aarch64-darwin = {
          asset = "boci-darwin-arm64";
          sha256 = "0e824720e4d92728fdf4808078cabbf3d79db203ca543f9b383657116e310c17";
        };
      };
      forAllSystems = f:
        nixpkgs.lib.genAttrs (builtins.attrNames sources) (system:
          f system (import nixpkgs { inherit system; }) sources.${system});
    in
    {
      packages = forAllSystems (system: pkgs: src: {
        default = pkgs.stdenv.mkDerivation {
          pname = "boci";
          inherit version;
          src = pkgs.fetchurl {
            url = "https://github.com/neves/boci/releases/download/v${version}/${src.asset}";
            inherit (src) sha256;
          };
          dontUnpack = true;
          installPhase = ''
            install -Dm755 $src $out/bin/boci
          '';
        };
      });
    };
}
