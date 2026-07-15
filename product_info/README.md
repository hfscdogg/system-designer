# Product Info Rule

Whenever we have extra notes about a D-Tools product that are not part of the product schema, we save them locally in this folder.

## Purpose

This gives Henry a stable local record of:
- installation notes
- product preferences
- compatibility reminders
- sourcing or stocking notes
- any extra context tied to a D-Tools product id

## File naming

Files are saved as:

```text
product_info/<product-id>_info.json
```

Example:

```text
product_info/8e1b0c2d-1234-5678-9012-abcdefabcdef_info.json
```

## Manifest

This folder also contains:

```text
product_info/manifest.json
```

It keeps a mapping from:
- `product id`
- to the local extra info file

It also stores a small summary for each product we have added notes for.

## Helper

Use:

```text
skills/d-tools-skill/scripts/product_info_store.js
```

## Rule for future work

Whenever we receive extra product information that is not part of the D-Tools schema:
1. save it in `product_info/<product-id>_info.json`
2. update `product_info/manifest.json` with the mapping
