{
  description = "Fast Bun drop-in replacement for the OCI CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      version = "0.0.2";
      sources = {
        x86_64-linux = {
          asset = "boci-linux-x64";
          sha256 = "dd42fad0dc04b8a5bf7896a2dddc2b8820d89f82be469dfd5df8f606e9b8f846";
        };
        aarch64-linux = {
          asset = "boci-linux-arm64";
          sha256 = "c806607753e016eb25c1f64d8f7ce938d4f9e97e74d9fcc2d4e7b912bdfb492e";
        };
        x86_64-darwin = {
          asset = "boci-darwin-x64";
          sha256 = "11a85865ed4de0313f17b847b08319011c485d63e537829436098c620f0973ba";
        };
        aarch64-darwin = {
          asset = "boci-darwin-arm64";
          sha256 = "aee2883c2052985f74fa8d4df32663b6833087c68cd51bb0d7c383f7c2e2b79a";
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
