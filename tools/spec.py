r"""仕様から作る（スペックドリブン開発）の道具。標準ライブラリだけ。

    python spec.py init <サービス>                       # specs/ に constitution.md と product.md のひな形を置く
    python spec.py new <サービス> <番号> <英名> "<機能の名前>"  # specs/NNN-英名/ に requirements・design・tasks を作る
    python spec.py list <サービス>                       # 機能ごとの状態・基準の数・テストのある数・タスクの進み
    python spec.py check <サービス> [--strict]           # 基準とテストの対応を検査する

サービスは products/<サービス>/。試すときは --products <一時フォルダ> を先頭に付ける。
基準の番号は R-<機能の番号3桁>-<連番>。requirements.md に「- **R-NNN-n** 〜」の形で書く。
--strict は、状態が「実装」「完了」の機能に、テストのない基準があれば終了コード1を返す（CI で使う）。
"""
import argparse
import re
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
JOB = HERE.parent.parent.parent
TEMPLATES = HERE / "templates"
STATES = ["要件", "設計", "実装", "完了"]
STRICT_STATES = {"実装", "完了"}
SKIP_DIRS = {"specs", "node_modules", ".git", ".next", "out", "dist", "build", "coverage", ".wrangler", ".turbo"}
TEXT_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sql", ".py", ".json", ".yml", ".yaml", ".toml", ".sh"}
DEF_RE = re.compile(r"^\s*[-*]\s*\*{0,2}(R-(\d{3})-(\d+))\*{0,2}")
REF_RE = re.compile(r"R-\d{3}-\d+")
STATE_RE = re.compile(r"^状態：\s*(\S+)", re.M)
TASK_RE = re.compile(r"^\s*[-*]\s*\[( |x|X)\]", re.M)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def product_dir(args) -> Path:
    base = Path(args.products) if args.products else JOB / "products"
    d = base / args.product
    if not d.is_dir():
        sys.exit(f"サービスのフォルダがない：{d}")
    return d


def fill(text: str, **kw) -> str:
    for k, v in kw.items():
        text = text.replace("{{" + k + "}}", v)
    return text


def cmd_init(args):
    d = product_dir(args)
    specs = d / "specs"
    specs.mkdir(exist_ok=True)
    for name in ["constitution.md", "product.md"]:
        dst = specs / name
        if dst.exists():
            print(f"そのまま：{dst.relative_to(d)}（もうある）")
            continue
        dst.write_text(fill((TEMPLATES / name).read_text(encoding="utf-8"), PRODUCT=args.product,
                            DATE=date.today().isoformat()), encoding="utf-8")
        print(f"作った：{dst.relative_to(d)}")


def features(d: Path):
    specs = d / "specs"
    if not specs.is_dir():
        return []
    return sorted(p for p in specs.iterdir() if p.is_dir() and re.match(r"\d{3}-", p.name))


def cmd_new(args):
    d = product_dir(args)
    if not re.fullmatch(r"\d{3}", args.number):
        sys.exit("番号は3桁（例：001）")
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", args.slug):
        sys.exit("英名は英小文字・数字・ハイフン（例：tenants-users）")
    for f in features(d):
        if f.name.startswith(args.number + "-"):
            sys.exit(f"番号 {args.number} はもう使われている：{f.name}")
    fd = d / "specs" / f"{args.number}-{args.slug}"
    fd.mkdir(parents=True)
    kw = dict(NUM=args.number, NAME=args.name, SLUG=args.slug, DATE=date.today().isoformat(), PRODUCT=args.product)
    for name in ["requirements.md", "design.md", "tasks.md"]:
        (fd / name).write_text(fill((TEMPLATES / name).read_text(encoding="utf-8"), **kw), encoding="utf-8")
    print(f"作った：{fd.relative_to(d)}（requirements.md・design.md・tasks.md）")


def read_feature(fd: Path):
    req = fd / "requirements.md"
    text = req.read_text(encoding="utf-8") if req.exists() else ""
    m = STATE_RE.search(text)
    state = m.group(1) if m else "？"
    defs = []
    for i, line in enumerate(text.splitlines(), 1):
        mm = DEF_RE.match(line)
        if mm:
            defs.append((mm.group(1), mm.group(2), i))
    tasks = fd / "tasks.md"
    marks = TASK_RE.findall(tasks.read_text(encoding="utf-8")) if tasks.exists() else []
    done = sum(1 for x in marks if x.lower() == "x")
    return state, defs, done, len(marks)


def scan_refs(d: Path) -> dict:
    refs: dict[str, set] = {}
    for p in d.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in TEXT_EXT:
            continue
        rel = p.relative_to(d)
        if any(part in SKIP_DIRS for part in rel.parts[:-1]):
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for rid in set(REF_RE.findall(text)):
            refs.setdefault(rid, set()).add(str(rel).replace("\\", "/"))
    return refs


def cmd_list(args):
    d = product_dir(args)
    refs = scan_refs(d)
    fs = features(d)
    if not fs:
        print("機能はまだない（spec.py new で作る）")
        return
    print("| 機能 | 状態 | 基準 | テストあり | タスク |")
    print("|---|---|---|---|---|")
    for fd in fs:
        state, defs, done, total = read_feature(fd)
        tested = sum(1 for rid, _, _ in defs if rid in refs)
        print(f"| {fd.name} | {state} | {len(defs)} | {tested} | {done}/{total} |")


def cmd_check(args):
    d = product_dir(args)
    refs = scan_refs(d)
    problems, warnings = [], []
    defined = {}
    for fd in features(d):
        num = fd.name[:3]
        state, defs, _, _ = read_feature(fd)
        if state not in STATES:
            problems.append(f"{fd.name}：状態が「{state}」（{'・'.join(STATES)} のどれか）")
        for rid, fnum, line in defs:
            where = f"{fd.name}/requirements.md:{line}"
            if rid in defined:
                problems.append(f"{rid}：番号が重なっている（{defined[rid]} と {where}）")
                continue
            defined[rid] = where
            if fnum != num:
                problems.append(f"{rid}：機能 {num} のフォルダにあるのに番号が {fnum}（{where}）")
            if rid not in refs:
                msg = f"{rid}：テストがない（{where}）"
                (problems if (args.strict and state in STRICT_STATES) else warnings).append(msg)
    for rid, files in sorted(refs.items()):
        if rid not in defined:
            problems.append(f"{rid}：仕様にない番号がコードにある（{', '.join(sorted(files))}）")
    total = len(defined)
    tested = sum(1 for r in defined if r in refs)
    print(f"基準 {total} 件、テストあり {tested} 件")
    for w in warnings:
        print(f"  まだ：{w}")
    for p in problems:
        print(f"  問題：{p}")
    if problems:
        sys.exit(1)
    print("問題なし")


def main():
    ap = argparse.ArgumentParser(description="仕様から作る（スペックドリブン開発）の道具")
    ap.add_argument("--products", help="products/ の代わりに使うフォルダ（試すとき）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("init"); a.add_argument("product"); a.set_defaults(fn=cmd_init)
    a = sub.add_parser("new"); a.add_argument("product"); a.add_argument("number"); a.add_argument("slug"); a.add_argument("name"); a.set_defaults(fn=cmd_new)
    a = sub.add_parser("list"); a.add_argument("product"); a.set_defaults(fn=cmd_list)
    a = sub.add_parser("check"); a.add_argument("product"); a.add_argument("--strict", action="store_true"); a.set_defaults(fn=cmd_check)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
