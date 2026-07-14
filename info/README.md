# Opportunity Info Rule

Whenever we create or update an opportunity in D-Tools, we also save a local JSON snapshot in this folder.

## Purpose

This gives Henry a stable local record of:
- the latest opportunity fields
- linked contacts/resources
- any D-Tools defaults or changes after create/update

## File naming

Files are saved as:

```text
info/<opportunity-number>.json
```

Example:

```text
info/P-2565.json
```

Extra information that does not belong to the D-Tools schema is saved as:

```text
info/<opportunity-id>_info.json
```

Example:

```text
info/0c5c8e1b-92c9-4b22-9d4d-34c54f13b1c1_info.json
```

## Manifest

This folder also contains:

```text
info/manifest.json
```

It keeps a mapping from:
- `opportunity id`
- to the local snapshot file

It also stores a small summary for each opportunity we have created or edited.
It also stores the mapping to the extra info file when one exists.

## Sync command

```bash
set -a; source .env; set +a
node skills/d-tools-skill/scripts/sync_opportunity_info.js --id <OPPORTUNITY_ID>
```

## Rule for future work

After every opportunity create or update:
1. fetch the full opportunity with `GetOpportunity`
2. save/update its snapshot JSON in this folder
3. update `info/manifest.json`

Whenever we receive extra opportunity information that is not part of the D-Tools schema:
1. save it in `info/<opportunity-id>_info.json`
2. update `info/manifest.json` with the mapping
