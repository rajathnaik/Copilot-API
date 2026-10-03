#!/usr/bin/env python3
"""Generate VS Code Custom Endpoint configuration; never write an API key."""

import argparse
import getpass
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("The API redirected the request. Check the tunnel URL/authentication.")


def normalize_base_url(url):
    parts = urlsplit(url.strip())
    if (
        parts.scheme not in ("https", "http")
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise ValueError("Use an HTTP(S) API base URL without credentials, query, or fragment.")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Remote endpoints must use HTTPS to protect the API key.")
    path = parts.path.rstrip("/")
    if path.endswith(("/models", "/chat/completions", "/responses", "/messages")):
        raise ValueError("Use the API base URL, not a models or inference endpoint.")
    if not path.endswith("/v1"):
        path += "/v1"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def fetch_catalog(base_url, key):
    request = Request(
        base_url + "/models",
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    with build_opener(NoRedirects()).open(request, timeout=30) as response:
        return json.load(response)


def positive_integer(value, label):
    if type(value) is not int or value <= 0:
        raise ValueError(label + " must be a positive integer.")
    return value


def generate_config(catalog, base_url, secret_ref, group):
    if not isinstance(catalog, dict) or not isinstance(catalog.get("data"), list):
        raise ValueError("Expected an OpenAI model catalog with a data array.")
    if catalog.get("has_more"):
        raise ValueError("The catalog is paginated; fetch the complete catalog before generating.")
    if not secret_ref.startswith("${input:") or not secret_ref.endswith("}") or len(secret_ref) <= 9:
        raise ValueError("The secret reference must be a VS Code ${input:...} reference, not a key.")

    models = []
    skipped = []
    seen = set()
    for model in catalog["data"]:
        if not isinstance(model, dict) or not isinstance(model.get("id"), str) or not model["id"]:
            raise ValueError("Every catalog entry must have a non-empty string id.")
        model_id = model["id"]
        if model_id in seen:
            raise ValueError("Duplicate model id: " + model_id)
        seen.add(model_id)
        capabilities = model.get("capabilities")
        if not isinstance(capabilities, dict):
            raise ValueError(model_id + ": missing capability metadata; cannot infer safely.")
        if capabilities.get("type") in ("embedding", "embeddings"):
            skipped.append(model_id + ": embedding model")
            continue
        if capabilities.get("type") != "chat":
            skipped.append(model_id + ": not advertised as a chat model")
            continue
        endpoints = model.get("supported_endpoints")
        if not isinstance(endpoints, list) or not all(isinstance(x, str) for x in endpoints):
            raise ValueError(model_id + ": missing or invalid supported_endpoints.")
        paths = {x.removeprefix("/v1") for x in endpoints}
        if "/chat/completions" in paths:
            api_type, suffix = "chat-completions", "/chat/completions"
        elif "/responses" in paths or "ws:/responses" in paths:
            api_type, suffix = "responses", "/responses"
        elif "/messages" in paths:
            api_type, suffix = "messages", "/messages"
        else:
            skipped.append(model_id + ": no supported client protocol")
            continue

        limits = capabilities.get("limits")
        supports = capabilities.get("supports")
        if not isinstance(limits, dict) or not isinstance(supports, dict):
            raise ValueError(model_id + ": missing limits or supports metadata.")
        output = positive_integer(limits.get("max_output_tokens"), model_id + " output limit")
        prompt = positive_integer(limits.get("max_prompt_tokens"), model_id + " prompt limit")
        context = limits.get("max_context_window_tokens")
        if context is not None:
            context = positive_integer(context, model_id + " context limit")
            prompt = min(prompt, context - output)
            positive_integer(prompt, model_id + " remaining input budget")
        for capability in ("tool_calls", "vision"):
            if type(supports.get(capability)) is not bool:
                raise ValueError(model_id + ": missing boolean capability " + capability)
        name = model.get("display_name") or model.get("name") or model_id
        if not isinstance(name, str):
            raise ValueError(model_id + ": invalid display name.")
        models.append({
            "id": model_id,
            "name": name,
            "apiType": api_type,
            "url": base_url + suffix,
            "toolCalling": supports["tool_calls"],
            "vision": supports["vision"],
            "maxInputTokens": prompt,
            "maxOutputTokens": output,
        })
    if not models:
        raise ValueError("No usable chat models found; no configuration was generated.")
    return [{
        "name": group,
        "vendor": "customendpoint",
        "apiKey": secret_ref,
        "models": models,
    }], skipped


def read_vscode_config(path, group):
    original = path.read_bytes()
    try:
        providers = json.loads(original.decode("utf-8-sig"))
    except ValueError as error:
        raise ValueError(
            "VS Code configuration must be valid JSON without comments or trailing commas. "
            "The file has not been changed."
        ) from error
    if not isinstance(providers, list) or not all(isinstance(p, dict) for p in providers):
        raise ValueError("VS Code configuration must be an array of provider objects.")
    matches = [
        index for index, provider in enumerate(providers)
        if provider.get("name") == group and provider.get("vendor") == "customendpoint"
    ]
    if len(matches) != 1:
        raise ValueError("Expected exactly one Custom Endpoint provider named " + group + ".")
    return original, providers, matches[0]


def update_vscode_config(path, original, providers, index, generated):
    updated = dict(providers[index])
    updated.pop("url", None)
    updated["apiKey"] = generated["apiKey"]
    updated["models"] = generated["models"]
    providers[index] = updated
    text = json.dumps(providers, indent=2, ensure_ascii=True) + "\n"
    if path.read_bytes() != original:
        raise ValueError("VS Code configuration changed during generation; retry after saving it.")
    descriptor, backup_name = tempfile.mkstemp(prefix=path.name + ".backup-", dir=path.parent)
    backup = Path(backup_name)
    with os.fdopen(descriptor, "wb") as output:
        output.write(original)
    shutil.copymode(path, backup)
    descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(text)
        shutil.copymode(path, temporary)
        if path.read_bytes() != original:
            raise ValueError("VS Code configuration changed during generation; original preserved.")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return backup


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Gateway host or /v1 base URL")
    parser.add_argument("--secret-ref", help="VS Code ${input:...} reference; reused when updating")
    parser.add_argument("--name", default="My Copilot API")
    parser.add_argument("--catalog", type=Path, help="Read a saved JSON catalog instead of fetching")
    destination = parser.add_mutually_exclusive_group()
    destination.add_argument("--output", type=Path, help="Generated JSON file")
    destination.add_argument("--update-vscode", type=Path, help="Update an existing VS Code model config")
    parser.add_argument("--force", action="store_true", help="Replace the generated output file")
    args = parser.parse_args(argv)
    try:
        base_url = normalize_base_url(args.base_url)
        args.output = (args.output or Path("vscode-models.generated.json")).expanduser()
        target = args.update_vscode.expanduser() if args.update_vscode else args.output
        if args.update_vscode:
            if args.force:
                raise ValueError("--force applies only to generated output, not --update-vscode.")
            target = target.resolve(strict=True)
            original, providers, index = read_vscode_config(target, args.name)
            secret_ref = args.secret_ref or providers[index].get("apiKey")
        else:
            secret_ref = args.secret_ref
        if not isinstance(secret_ref, str):
            raise ValueError("Provide --secret-ref or store an input reference in the existing provider.")
        if not args.update_vscode and args.output.exists() and not args.force:
            raise ValueError("Output exists. Use --force to replace it, or choose another --output.")
        if args.catalog and args.catalog.expanduser().resolve() == target.resolve():
            raise ValueError("The output must not overwrite the input catalog.")
        if args.catalog:
            catalog = json.loads(args.catalog.expanduser().read_text(encoding="utf-8-sig"))
        else:
            key = os.environ.get("COPILOT_API_KEY") or getpass.getpass("API service key (hidden): ")
            if not key.strip():
                raise ValueError("An API service key is required.")
            catalog = fetch_catalog(base_url, key)
        config, skipped = generate_config(catalog, base_url, secret_ref, args.name)
        if args.update_vscode:
            backup = update_vscode_config(target, original, providers, index, config[0])
            print("Updated {} chat models in {}".format(len(config[0]["models"]), target))
            print("Backup: " + str(backup))
            print("Reload VS Code. Do not save an older unsaved configuration over this update.")
        else:
            text = json.dumps(config, indent=2, ensure_ascii=True) + "\n"
            with args.output.open("w" if args.force else "x", encoding="utf-8") as output:
                output.write(text)
            print("Generated {} chat models in {}".format(len(config[0]["models"]), args.output))
            print("Copy the generated provider into VS Code's language-model configuration.")
        for reason in skipped:
            print("Skipped " + reason, file=sys.stderr)
        print("Inference/tool calls have not been verified.")
        return 0
    except HTTPError as error:
        print("Error: model discovery returned HTTP {}. Check API/tunnel authentication and URL."
              .format(error.code), file=sys.stderr)
    except URLError as error:
        print("Error: cannot reach the API: " + str(error.reason), file=sys.stderr)
    except (OSError, ValueError) as error:
        print("Error: " + str(error), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
