#!/usr/bin/env python3
"""Parse DRM-free EPUB books into chapter records. Use the navigation table of contents when available, otherwise preserve spine order; return the section shape consumed by book_to_audio."""
import io
import posixpath
import re
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

from lxml import etree

from book_to_audio import read_book_bytes, safe_name

# Block-level tags after which we insert a paragraph break in the extracted text.
_BLOCK_TAGS = {"p", "div", "br", "h1", "h2", "h3", "h4", "li", "blockquote", "section"}
_SKIP_TAGS = {"script", "style", "head"}


class _TextExtractor(HTMLParser):
    """Pull the first heading (as a title) and readable body text from XHTML."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts = []
        self._skip = 0
        self._in_heading = False
        self.title = None
        self._title_buf = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip += 1
        if tag in ("h1", "h2", "h3", "title") and self.title is None:
            self._in_heading = True
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS and self._skip:
            self._skip -= 1
        if tag in ("h1", "h2", "h3", "title") and self._in_heading:
            self._in_heading = False
            if self.title is None:
                t = " ".join("".join(self._title_buf).split())
                self.title = t or None
            self._title_buf = []
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data):
        if self._skip:
            return
        if self._in_heading:
            # The captured heading becomes the section TITLE, and parse_epub
            # prepends the title to the section text ("<title>.\n\n<body>") —
            # so the heading must NOT also stay in the body, or every EPUB
            # chapter narrates its title twice ("Chapter 1. Chapter 1. …").
            # Only the FIRST heading is captured; later h2/h3s stay in the body.
            self._title_buf.append(data)
            return
        self._parts.append(data)

    def text(self):
        raw = "".join(self._parts)
        # collapse to clean paragraphs
        lines = [" ".join(ln.split()) for ln in raw.split("\n")]
        return "\n\n".join(ln for ln in lines if ln)


def _extract(html: str):
    p = _TextExtractor()
    p.feed(html)
    return p.title, p.text()


_EPUB_NS = "http://www.idpf.org/2007/ops"


def _xml_root(data: bytes):
    """Parse package/navigation XML without loading DTDs, entities, or network data."""
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                             recover=False, huge_tree=False)
    return etree.fromstring(data, parser)


def _local_name(node) -> str:
    return etree.QName(node).localname.lower() if isinstance(node.tag, str) else ""


def _archive_path(path: str) -> str | None:
    """Normalize an already-decoded member path and reject archive traversal."""
    if not path or path.startswith(("/", "\\")) or "\\" in path:
        return None
    normalized = posixpath.normpath(path)
    if normalized in ("", ".", "..") or normalized.startswith("../"):
        return None
    return normalized


def _resolve_href(owner_path: str, href: str) -> tuple[str | None, str | None]:
    """Resolve a package/nav/NCX URI against its owning document."""
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc:
        return None, None
    raw_path = unquote(parsed.path)
    if not raw_path:
        member = owner_path
    else:
        member = _archive_path(posixpath.join(posixpath.dirname(owner_path), raw_path))
    return member, unquote(parsed.fragment) or None


def _manifest(root, opf_path: str) -> tuple[dict, list[str], str | None]:
    """Return manifest records, spine item IDs, and the optional NCX item ID."""
    items = {}
    for node in root.iter():
        if _local_name(node) != "item":
            continue
        item_id = node.get("id")
        href = node.get("href")
        if not item_id or not href:
            continue
        path, _fragment = _resolve_href(opf_path, href)
        if path:
            items[item_id] = {
                "path": path,
                "media_type": (node.get("media-type") or "").lower(),
                "properties": set((node.get("properties") or "").split()),
            }
    spine = next((node for node in root.iter() if _local_name(node) == "spine"), None)
    spine_ids = [node.get("idref") for node in (spine if spine is not None else ())
                 if _local_name(node) == "itemref" and node.get("idref")]
    return items, spine_ids, spine.get("toc") if spine is not None else None


def _nav_entries(root) -> list[tuple[str | None, str]]:
    """Flatten the EPUB 3 TOC in document order, including linked parent entries."""
    nav = next((node for node in root.iter()
                if _local_name(node) == "nav" and
                any(key == f"{{{_EPUB_NS}}}type" and "toc" in (value or "").split()
                    for key, value in node.attrib.items())), None)
    if nav is None:
        return []
    entries = []

    def walk(node):
        if _local_name(node) == "li":
            for child in node:
                if _local_name(child) == "a" and child.get("href"):
                    title = " ".join("".join(child.itertext()).split()) or None
                    entries.append((title, child.get("href")))
                else:
                    walk(child)
            return
        for child in node:
            walk(child)

    for child in nav:
        if _local_name(child) == "ol":
            walk(child)
    return entries


def _ncx_entries(root) -> list[tuple[str | None, str]]:
    """Flatten EPUB 2 NCX navPoints, preserving parent links and nested order."""
    nav_map = next((node for node in root.iter() if _local_name(node) == "navmap"), None)
    if nav_map is None:
        return []
    entries = []

    def walk(node):
        if _local_name(node) == "navpoint":
            label = next((child for child in node if _local_name(child) == "navlabel"), None)
            text_node = next((part for part in label.iter() if _local_name(part) == "text"), None) if label is not None else None
            content = next((child for child in node if _local_name(child) == "content"), None)
            if content is not None and content.get("src"):
                title = " ".join("".join(text_node.itertext()).split()) if text_node is not None else ""
                entries.append((title or None, content.get("src")))
        for child in node:
            walk(child)

    for child in nav_map:
        walk(child)
    return entries


def _resolve_document(href: str, owner_path: str, documents: dict) -> tuple[str | None, str | None]:
    path, fragment = _resolve_href(owner_path, href)
    if path in documents:
        return path, fragment
    # Older books sometimes omit directory prefixes. Only use this compatibility
    # fallback when exactly one manifest document has the decoded basename.
    if path:
        base = posixpath.basename(path)
        matches = [candidate for candidate in documents
                   if posixpath.basename(candidate) == base]
        if len(matches) == 1:
            return matches[0], fragment
    return None, fragment


def _anchor_offset(html: str, frag: str):
    """Character offset in `html` where the element carrying id/name == frag begins
    (backed up to its opening '<'), or None if not found. The lookbehind keeps
    `id=` from matching inside compound attributes like `data-id=`."""
    for pat in (rf'(?<![\w-])id\s*=\s*["\']{re.escape(frag)}["\']',
                rf'(?<![\w-])name\s*=\s*["\']{re.escape(frag)}["\']'):
        m = re.search(pat, html)
        if m:
            lt = html.rfind("<", 0, m.start())
            return lt if lt != -1 else m.start()
    return None


def _split_by_anchors(html: str, group: list) -> list:
    """Split one XHTML file into pieces at the anchor fragments referenced by a run
    of TOC entries (each a (title, name, frag, item) tuple). Returns [(title, text)]
    in TOC order.

    Entries whose anchor can't be FOUND in the HTML (typo'd/missing id — a real
    authoring defect in the wild) are excluded from the split rather than mapped
    to offset 0: mapping them to 0 would steal the file-start content from the
    entry that legitimately owns it AND emit that legitimate chapter as empty.
    The missing entry yields no separate section; its text stays inside the
    neighboring piece. If fewer than two distinct split points remain, fall back
    to one whole-file piece (degrades to old behavior, never to lost text)."""
    located = []                                   # [(k, offset)] — found anchors only
    for k, (_title, _name, frag, _item) in enumerate(group):
        off = 0 if not frag else _anchor_offset(html, frag)
        if off is not None:
            located.append((k, off))
    if len({off for _k, off in located}) <= 1:
        _t, text = _extract(html)
        return [(group[0][0] or _t, text)]
    located.sort(key=lambda p: p[1])
    piece_by_k = {}
    for rank, (k, start) in enumerate(located):
        end = located[rank + 1][1] if rank + 1 < len(located) else len(html)
        _t, text = _extract(html[start:end])
        piece_by_k[k] = (group[k][0] or _t, text)
    # Unlocated entries come back empty; the caller's empty-text check skips them.
    return [piece_by_k.get(k, (group[k][0], "")) for k in range(len(group))]


def parse_epub(path) -> list:
    """Read an EPUB from the vault byte seam and return narrated sections."""
    data = read_book_bytes(path)
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError("invalid EPUB archive") from exc

    with archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("EPUB contains duplicate archive paths")
        try:
            container = _xml_root(archive.read("META-INF/container.xml"))
            rootfile = next(node for node in container.iter()
                            if _local_name(node) == "rootfile" and node.get("full-path"))
            package_ref = rootfile.get("full-path")
            opf_path = _archive_path(package_ref)
            if opf_path not in names:
                decoded_opf_path = _archive_path(unquote(package_ref))
                if decoded_opf_path in names:
                    opf_path = decoded_opf_path
            if not opf_path or opf_path not in names:
                raise ValueError("invalid EPUB package path")
            opf = _xml_root(archive.read(opf_path))
        except (KeyError, StopIteration, etree.XMLSyntaxError) as exc:
            raise ValueError("EPUB container or package metadata is invalid") from exc

        manifest, spine_ids, ncx_id = _manifest(opf, opf_path)
        available = set(names)
        documents = {item["path"]: item for item in manifest.values()
                     if item["media_type"] in ("application/xhtml+xml", "text/html")
                     and item["path"] in available}
        toc = []
        nav_item = next((item for item in manifest.values() if "nav" in item["properties"]), None)
        if nav_item is not None and nav_item["path"] in names:
            try:
                toc = _nav_entries(_xml_root(archive.read(nav_item["path"])))
                toc_owner = nav_item["path"]
            except etree.XMLSyntaxError:
                toc = []
                toc_owner = ""
        else:
            toc_owner = ""
        if not toc:
            ncx_item = manifest.get(ncx_id) if ncx_id else next(
                (item for item in manifest.values()
                 if item["media_type"] == "application/x-dtbncx+xml"), None)
            if ncx_item is not None and ncx_item["path"] in names:
                try:
                    toc = _ncx_entries(_xml_root(archive.read(ncx_item["path"])))
                    toc_owner = ncx_item["path"]
                except etree.XMLSyntaxError:
                    toc = []

        ordered = []
        for title, href in toc:
            item_path, fragment = _resolve_document(href, toc_owner, documents)
            if item_path:
                ordered.append((title, item_path, fragment, documents[item_path]))
        if not ordered:
            for item_id in spine_ids:
                item = manifest.get(item_id)
                if item and item["path"] in documents:
                    ordered.append((None, item["path"], None, item))

        sections, idx, seen = [], 0, set()
        i = 0
        while i < len(ordered):
            name, item = ordered[i][1], ordered[i][3]
            group = []
            while i < len(ordered) and ordered[i][1] == name:
                group.append(ordered[i])
                i += 1
            if name in seen:
                continue
            seen.add(name)
            html = archive.read(name).decode("utf-8", errors="replace")
            if len(group) > 1 and any(entry[2] for entry in group):
                pieces = _split_by_anchors(html, group)
            else:
                doc_title, text = _extract(html)
                pieces = [(group[0][0] or doc_title, text)]
            for title_hint, text in pieces:
                if not text.strip():
                    continue
                title = (title_hint or f"Chapter {idx + 1}").strip()
                full = (title.rstrip(".") + ".\n\n" + text).strip()
                sections.append({"index": idx, "title": title,
                                 "filename": f"{idx:02d}_{safe_name(title)}", "text": full})
                idx += 1
        return sections
