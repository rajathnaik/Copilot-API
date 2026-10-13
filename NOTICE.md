# Notice

## GitHub Copilot Security Notice

Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.

You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.

GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.

Please review:

- [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
- [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)

Use this project responsibly to avoid account restrictions.

## Project Lineage

This repository, [`rajathnaik/Copilot-API`](https://github.com/rajathnaik/Copilot-API),
is maintained by Rajath Naik. It builds on
[`caozhiyuan/copilot-api`](https://github.com/caozhiyuan/copilot-api), which in turn
continued [`ericc-ch/copilot-api`](https://github.com/ericc-ch/copilot-api).

Earlier versions of this fork shipped separate Gateway and Connector
products. ModelBridge is now a clean-slate desktop product rebuild with new
contracts and an independent installation identity. Historical source and
published releases retain the original project lineage; they are not removed
by the active-source cleanup.

ModelBridge retains the original direct Copilot device-code authentication,
token exchange and service forwarding, and reuses the original Responses,
Messages and Chat Completions translations. It does not use the Copilot SDK.
These integrations depend on internal service behaviour and can change without
notice; a subscription and successful model discovery do not guarantee every
model's inference capabilities or permission to redistribute access.

## Acknowledgements

Microsoft Dev Tunnels CLI is separately licensed proprietary Microsoft software.
ModelBridge does not distribute, download or install it. The installer links to
[Microsoft's instructions](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)
and checks an existing installation for the host role. Users install the CLI
separately under [Microsoft's terms](https://aka.ms/devtunnels/tos).
The MIT-licensed Dev Tunnels SDK does not grant redistribution rights to the CLI.

Many thanks to Erick Christian Purwanto, caozhiyuan, and the contributors to both
upstream projects for the foundation they built.

Their work made this independent continuation possible, and the original attribution remains preserved in [`LICENSE`](./LICENSE).
