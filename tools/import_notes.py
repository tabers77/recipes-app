"""Convert exported iPhone Notes into a recipes.json the app can import.

    python tools/import_notes.py path/to/recetas_temp.log
    python tools/import_notes.py path/to/recetas_temp.log -o recipes-import.json

Then in the app: Menu > Import JSON backup. The import merges by
last-write-wins, so running it twice does not create duplicates -- ids are
derived from the title, not generated fresh each run.

Three things in the source that a naive split gets wrong:

  1. "Recetas - General" is not one recipe. It holds seventeen of them, each
     introduced by a bare title line. Those titles are listed explicitly in
     GENERAL_TITLES below rather than guessed: a heuristic that decides "short
     line = title" also promotes "Usar chili" and "Hervir por 8 minutos".
  2. One block has no title at all -- just "Recetas" followed by a list of
     ideas. It becomes a single note-style entry rather than being dropped.
  3. "Lentejas" is Markdown (### headings, * bullets, **bold**) while every
     other block is plain text.

Nothing is discarded. Every non-blank source line ends up in exactly one of
ingredients / steps / links, and the script asserts that before writing.
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys

NOW = "2026-09-06T12:00:00.000Z"

# Sub-recipes inside the "General" block, in the order they appear.
GENERAL_TITLES = [
    "lasagna",
    "Panckaes plátano",
    "Berenjena",
    "Risotto",
    "Arroz chino",
    "Tortilla de papa con brócoli",
    "Mantequilla de ajo",
    "Patacones en airfryer",
    "Tigrillo",
    "Pasta con pistacho",
    "Pollo a la cerveza",
    "Encocado",
    "Patatas bravas",
    "Coles de Bruselas",
    "Pasta al ajo",
    "Tortilla en la airfryer",
    "Pan con ajo",
]

# A line that opens an ingredients list. Everything until the next section
# heading is an ingredient rather than a step.
INGREDIENT_HEADING = re.compile(r"^[^\w]*ingredientes\b", re.I)

# Headings that end an ingredients list.
SECTION_HEADING = re.compile(
    r"^[^\w]*(preparaci|proceso|m[ée]todo|pasos|paso\s|elaboraci|utensilios|"
    r"presentaci|notas|opci|truco|qu[ée] esperar|c[óo]mo hacer|glaseado|"
    r"para servir|resumen|cantidad base)", re.I)

URL_RE = re.compile(r"https?://\S+")

# Keyword -> category. Deliberately conservative: a recipe with no keyword hit
# gets no category rather than a wrong one.
CATEGORY_RULES = [
    ("Pasta", ("pasta", "carbonara", "calamarata", "spaghetti", "lasagna",
               "pinza", "limone", "pistacho")),
    ("Arroz", ("arroz", "risotto", "paella")),
    ("Carne", ("costillas", "entrecote", "carne", "beef", "pollo", "salsiccia",
               "manzo", "tocino")),
    ("Legumbres", ("lenteja", "lentejas")),
    ("Sopa", ("sopa", "menestrone")),
    ("Airfryer", ("airfyer", "airfryer", "air fryer")),
    ("Horno", ("horno", "polenta")),
    # "verde" alone is too greedy -- it matches "pimiento verde" in Lentejas.
    ("Ecuatoriana", ("tigrillo", "encocado", "patacones", "patacón")),
    # No time-in-minutes keyword: "25-30 minutos" inside a step is not a claim
    # that the dish is quick.
    ("Rápido", ("rápida", "rapidas", "express", "crepioca")),
]


def clean(line):
    """Strip Markdown decoration, keep the words."""
    s = line.rstrip()
    s = re.sub(r"^\s*#{1,6}\s*", "", s)          # ### Ingredientes
    s = re.sub(r"^\s*[*+]\s+", "", s)            # * bullet
    s = re.sub(r"^\s*-\s+(?=\S)", "", s)         # - bullet
    s = s.replace("**", "")
    return s.strip()


def categories_for(title, body):
    hay = (title + " " + body).lower()
    found = []
    for label, keywords in CATEGORY_RULES:
        if any(k in hay for k in keywords):
            found.append(label)
    return found[:3]                              # three chips is plenty


def stable_id(title):
    """Derived from the title so a re-import updates rather than duplicates."""
    digest = hashlib.sha256(title.strip().lower().encode("utf-8")).hexdigest()
    return "r_" + digest[:12]


def split_blocks(text):
    """Top-level split on lines beginning with 'Recetas'."""
    blocks = []
    current = None
    for raw in text.split("\n"):
        if raw.strip().startswith("Recetas"):
            if current:
                blocks.append(current)
            header = raw.strip()
            title = header[len("Recetas"):].lstrip(" -").strip()
            current = {"title": title, "lines": []}
        elif current is not None:
            current["lines"].append(raw)
    if current:
        blocks.append(current)
    return blocks


def split_general(lines):
    """Cut the General block at each known sub-recipe title."""
    remaining = list(GENERAL_TITLES)
    out = []
    current = None
    for raw in lines:
        stripped = raw.strip()
        if remaining and stripped.lower() == remaining[0].lower():
            if current:
                out.append(current)
            current = {"title": remaining.pop(0), "lines": []}
            continue
        if current is not None:
            current["lines"].append(raw)
    if current:
        out.append(current)
    if remaining:
        sys.exit("import: these General sub-recipes were never found: %s"
                 % ", ".join(remaining))
    return out


def build(title, lines):
    """Turn one block's lines into a recipe record. Loses nothing."""
    links, ingredients, steps = [], [], []
    in_ingredients = False
    placed = 0
    seen_urls = set()

    for raw in lines:
        line = clean(raw)
        if not line:
            continue
        placed += 1

        urls = URL_RE.findall(line)
        if urls:
            for url in urls:
                url = url.rstrip(".,;")
                if url not in seen_urls:
                    seen_urls.add(url)
                    links.append({"url": url, "label": ""})
            # A line that is only a URL carries nothing else.
            if not URL_RE.sub("", line).strip():
                continue
            line = URL_RE.sub("", line).strip()

        if INGREDIENT_HEADING.search(line):
            in_ingredients = True
            continue
        if in_ingredients and SECTION_HEADING.search(line):
            in_ingredients = False

        (ingredients if in_ingredients else steps).append(line)

    body = "\n".join(ingredients + steps)
    return {
        "id": stable_id(title),
        "title": title,
        "categories": categories_for(title, body),
        "servings": None,
        "timeMinutes": None,
        "ingredients": ingredients,
        "steps": steps,
        "links": links,
        "notes": "",
        "imageIds": [],
        "createdAt": NOW,
        "updatedAt": NOW,
        "deletedAt": None,
    }, placed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="the exported notes file")
    parser.add_argument("-o", "--out", default="recipes-import.json")
    args = parser.parse_args()

    if not os.path.isfile(args.source):
        sys.exit("import: %s does not exist" % args.source)

    text = io.open(args.source, encoding="utf-8").read()
    source_lines = sum(1 for l in text.split("\n")
                       if l.strip() and not l.strip().startswith("Recetas"))

    recipes = []
    placed_total = 0
    for block in split_blocks(text):
        if block["title"].lower() == "general":
            for sub in split_general(block["lines"]):
                record, placed = build(sub["title"], sub["lines"])
                recipes.append(record)
                placed_total += placed
        else:
            title = block["title"] or "Ideas — Burrata pasta, Pinza, Menestrone"
            record, placed = build(title, block["lines"])
            recipes.append(record)
            placed_total += placed

    # Nothing may be silently dropped. The General block's own title lines are
    # consumed as separators, hence the allowance.
    lost = source_lines - placed_total - len(GENERAL_TITLES)
    if lost != 0:
        sys.exit("import: %d source lines were not placed anywhere" % lost)

    ids = [r["id"] for r in recipes]
    if len(set(ids)) != len(ids):
        sys.exit("import: two recipes share an id (duplicate titles?)")

    payload = {"schemaVersion": 1, "exportedAt": NOW, "recipes": recipes}
    with io.open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print("%d recipes -> %s\n" % (len(recipes), args.out))
    print("%-42s %5s %5s %5s  %s" % ("TITLE", "INGR", "STEP", "LINK", "CATEGORIES"))
    for r in recipes:
        print("%-42s %5d %5d %5d  %s" % (
            r["title"][:42], len(r["ingredients"]), len(r["steps"]),
            len(r["links"]), ", ".join(r["categories"])))
    print("\nevery non-blank source line accounted for")


if __name__ == "__main__":
    main()
