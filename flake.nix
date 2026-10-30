{
  description = "cc-crew: reviews by other providers' models through cc-agents, as a Claude Code mod";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      # the plugin directory alone, at share/cc-crew/claude-code: Claude Code loads the .ts as is.
      # One level down, so a system profile links the plugin as one directory: Claude Code refuses
      # hooks that resolve outside the plugin directory, as per-file links into the store do.
      packages.${system}.default = pkgs.stdenvNoCC.mkDerivation {
        pname = "cc-crew";
        version = "0.1.0";
        src = self;
        dontBuild = true;
        installPhase = ''
          mkdir -p $out/share/cc-crew/claude-code/.claude-plugin
          cp .claude-plugin/plugin.json $out/share/cc-crew/claude-code/.claude-plugin/
          cp -r hooks crew.json prompts $out/share/cc-crew/claude-code/
        '';
      };
    };
}
