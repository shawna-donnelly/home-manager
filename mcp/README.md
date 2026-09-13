# Recipe importer MCP server

Gives a Claude account tools to add and plan meals in home-manager. Claude
parses a recipe (photo, pasted text, or URL) into structured form and calls
these tools; they persist via home-manager's meal API.

Tools: `list_recipes`, `add_recipe`, `plan_meal`.

## Run

    cp .env.example .env    # set MCP_TOKEN (openssl rand -hex 32), HOME_MANAGER_URL
    yarn install && yarn build && yarn start

Serves Streamable HTTP at `/mcp` (bearer auth) and `/health`. Expose over a
tunnel and add as a custom connector in Claude, or run locally and add to
Claude Code / Desktop.
