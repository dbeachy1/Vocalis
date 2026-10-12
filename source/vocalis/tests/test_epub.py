"""EPUB parser regressions using small standard-library ZIP/XML fixtures."""
from pathlib import Path
import posixpath
from zipfile import ZIP_STORED, ZipFile
from xml.sax.saxutils import escape
from urllib.parse import quote

import pytest

from conftest import make_test_epub, make_test_docx
from epub_parser import parse_epub


def _write_epub(path, docs, *, nav_markup=None, nav_path="OPS/nav.xhtml",
                ncx_markup=None, ncx_path="OPS/toc.ncx", spine=None,
                opf_doctype="", opf_title="Test Book"):
    """Write a tiny EPUB package without an EPUB authoring dependency."""
    entries = {
        "mimetype": b"application/epub+zip",
        "META-INF/container.xml": b'''<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
 <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>''',
    }
    manifest = []
    for index, (member, content) in enumerate(docs.items()):
        item_id = f"doc{index}"
        manifest.append(
            f'<item id="{item_id}" href="{escape(quote(posixpath.relpath(member, "OPS"), safe="/"))}" '
            'media-type="application/xhtml+xml"/>'
        )
        entries[member] = content.encode("utf-8") if isinstance(content, str) else content
    if nav_markup is not None:
        manifest.append(
            f'<item id="nav" href="{escape(quote(posixpath.relpath(nav_path, "OPS"), safe="/"))}" '
            'media-type="application/xhtml+xml" properties="nav"/>'
        )
        entries[nav_path] = (
            '<html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>'
            + nav_markup + '</ol></nav></body></html>'
        ).encode("utf-8")
    if ncx_markup is not None:
        manifest.append(
            f'<item id="ncx" href="{escape(quote(posixpath.relpath(ncx_path, "OPS"), safe="/"))}" '
            'media-type="application/x-dtbncx+xml"/>'
        )
        entries[ncx_path] = (
            '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>'
            + ncx_markup + '</navMap></ncx>'
        ).encode("utf-8")
    ordered_members = spine if spine is not None else list(docs)
    by_member = {member: f"doc{index}" for index, member in enumerate(docs)}
    spine_xml = "".join(f'<itemref idref="{by_member[member]}"/>' for member in ordered_members)
    toc_attr = ' toc="ncx"' if ncx_markup is not None else ""
    package = f'''{opf_doctype}<package xmlns="http://www.idpf.org/2007/opf"
        xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="uid">
      <metadata><dc:identifier id="uid">fixture-epub</dc:identifier>
        <dc:title>{opf_title}</dc:title><dc:language>en</dc:language></metadata>
      <manifest>{''.join(manifest)}</manifest><spine{toc_attr}>{spine_xml}</spine>
    </package>'''
    entries["OPS/package.opf"] = package.encode("utf-8")
    with ZipFile(path, "w") as archive:
        archive.writestr("mimetype", entries.pop("mimetype"), compress_type=ZIP_STORED)
        for member, content in entries.items():
            archive.writestr(member, content)


def _chapter(title, body):
    return (f'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
            f'<h1>{title}</h1><p>{body}</p></body></html>')


def test_epub_parses_expected_chapters(tmp_path):
    epub = tmp_path / "book.epub"
    make_test_epub(epub, num_chapters=3)
    sections = parse_epub(epub)
    assert len(sections) == 3
    assert [section["index"] for section in sections] == [0, 1, 2]
    assert sections[0]["title"] == "Chapter 1"
    assert sections[2]["title"] == "Chapter 3"
    assert "body of chapter 1" in sections[0]["text"].lower()
    assert sections[1]["filename"].startswith("01_")
    assert "/" not in sections[0]["filename"] and "\\" not in sections[0]["filename"]


def test_epub_section_shape_matches_docx(tmp_path):
    """EPUB sections retain the keys consumed by the DOCX narration pipeline."""
    from book_to_audio import parse_docx
    epub_path = tmp_path / "b.epub"
    make_test_epub(epub_path, num_chapters=2)
    docx = tmp_path / "b.docx"
    make_test_docx(docx, num_chapters=2)
    epub_section = parse_epub(epub_path)[0]
    docx_section = parse_docx(docx)[0]
    assert set(epub_section) == set(docx_section) == {"index", "title", "filename", "text"}


def test_epub_two_chapters(tmp_path):
    epub = tmp_path / "two.epub"
    make_test_epub(epub, num_chapters=2)
    assert len(parse_epub(epub)) == 2


def test_epub_splits_multiple_chapters_in_one_file(tmp_path):
    path = tmp_path / "anchors.epub"
    member = "OPS/text/all.xhtml"
    doc = ('<html xmlns="http://www.w3.org/1999/xhtml"><body>'
           '<h2 id="c1">Chapter One</h2><p>Body of Chapter One here.</p>'
           '<h2 id="c2">Chapter Two</h2><p>Body of Chapter Two here.</p></body></html>')
    _write_epub(path, {member: doc}, nav_path="OPS/nav/toc.xhtml",
                nav_markup='<li><a href="../text/all.xhtml#c1">Chapter One</a></li>'
                           '<li><a href="../text/all.xhtml#c2">Chapter Two</a></li>')
    sections = parse_epub(path)
    assert [section["title"] for section in sections] == ["Chapter One", "Chapter Two"]
    assert "body of chapter one" in sections[0]["text"].lower()
    assert "body of chapter two" in sections[1]["text"].lower()
    assert "chapter two" not in sections[0]["text"].lower()


def test_epub_resolves_encoded_href_relative_to_nav_document(tmp_path):
    path = tmp_path / "encoded.epub"
    member = "OPS/text/Come Find Me.xhtml"
    _write_epub(path, {member: _chapter("Chapter A", "encoded path body")},
                nav_path="OPS/navigation/toc.xhtml",
                nav_markup='<li><a href="../text/Come%20Find%20Me.xhtml">Encoded</a></li>')
    sections = parse_epub(path)
    assert len(sections) == 1
    assert sections[0]["title"] == "Encoded"
    assert "encoded path body" in sections[0]["text"]


def test_epub_decodes_uri_once_without_rewriting_literal_percent_in_archive_path(tmp_path):
    path = tmp_path / "literal-percent.epub"
    member = "OPS/Part One/text/Chapter%20One.xhtml"
    _write_epub(path, {member: _chapter("Chapter", "percent path body")},
                nav_path="OPS/Part One/navigation/toc.xhtml",
                nav_markup='<li><a href="../text/Chapter%2520One.xhtml">Percent Path</a></li>')
    sections = parse_epub(path)
    assert len(sections) == 1
    assert sections[0]["title"] == "Percent Path"
    assert "percent path body" in sections[0]["text"]


def test_epub_keeps_nested_nav_order_and_linked_parent(tmp_path):
    path = tmp_path / "nested.epub"
    docs = {
        "OPS/text/part.xhtml": _chapter("Part One", "parent body"),
        "OPS/text/one.xhtml": _chapter("Chapter One", "first body"),
        "OPS/text/two.xhtml": _chapter("Chapter Two", "second body"),
    }
    nav = ('<li><a href="../text/part.xhtml">Part One</a><ol>'
           '<li><a href="../text/one.xhtml">Chapter One</a></li>'
           '<li><a href="../text/two.xhtml">Chapter Two</a></li>'
           '</ol></li>')
    _write_epub(path, docs, nav_path="OPS/navigation/toc.xhtml", nav_markup=nav)
    sections = parse_epub(path)
    assert [section["title"] for section in sections] == ["Part One", "Chapter One", "Chapter Two"]
    assert [section["index"] for section in sections] == [0, 1, 2]


def test_epub_ncx_nested_order_and_paths_relative_to_ncx(tmp_path):
    path = tmp_path / "legacy.epub"
    docs = {
        "OPS/text/part.xhtml": _chapter("Part", "parent body"),
        "OPS/text/chapter.xhtml": _chapter("Chapter", "chapter body"),
    }
    ncx = ('<navPoint><navLabel><text>Part A</text></navLabel>'
           '<content src="../text/part.xhtml"/><navPoint>'
           '<navLabel><text>Chapter A</text></navLabel>'
           '<content src="../text/chapter.xhtml"/></navPoint></navPoint>')
    _write_epub(path, docs, ncx_path="OPS/toc/book.ncx", ncx_markup=ncx)
    sections = parse_epub(path)
    assert [section["title"] for section in sections] == ["Part A", "Chapter A"]


def test_epub_falls_back_to_spine_when_toc_entries_do_not_resolve(tmp_path):
    path = tmp_path / "spine.epub"
    docs = {"OPS/text/one.xhtml": _chapter("First", "first body"),
            "OPS/text/two.xhtml": _chapter("Second", "second body")}
    _write_epub(path, docs, nav_markup='<li><a href="missing.xhtml">Unresolved</a></li>')
    sections = parse_epub(path)
    assert [section["title"] for section in sections] == ["First", "Second"]


def test_epub_uses_only_unambiguous_basename_fallback(tmp_path):
    path = tmp_path / "basename.epub"
    docs = {"OPS/text/chapter.xhtml": _chapter("First", "first body"),
            "OPS/extra/chapter.xhtml": _chapter("Second", "second body")}
    _write_epub(path, docs, nav_markup='<li><a href="missing/chapter.xhtml">TOC</a></li>')
    sections = parse_epub(path)
    assert [section["title"] for section in sections] == ["First", "Second"]


def test_epub_unambiguous_basename_resolves_navigation_entry(tmp_path):
    path = tmp_path / "basename-unique.epub"
    member = "OPS/text/chapter.xhtml"
    _write_epub(path, {member: _chapter("Chapter", "matched body")},
                nav_markup='<li><a href="missing/chapter.xhtml">Matched TOC</a></li>')
    sections = parse_epub(path)
    assert len(sections) == 1
    assert sections[0]["title"] == "Matched TOC"
    assert "matched body" in sections[0]["text"]


def test_epub_file_referenced_twice_is_not_duplicated(tmp_path):
    path = tmp_path / "duplicate.epub"
    a = "OPS/text/a.xhtml"
    b = "OPS/text/b.xhtml"
    docs = {
        a: ('<html xmlns="http://www.w3.org/1999/xhtml"><body>'
            '<h2 id="c1">Chapter One</h2><p>UNIQUE-ALPHA body.</p>'
            '<h2 id="c2">Chapter Two</h2><p>UNIQUE-BETA body.</p></body></html>'),
        b: _chapter("Interlude", "UNIQUE-GAMMA body."),
    }
    nav = ('<li><a href="text/a.xhtml#c1">Chapter One</a></li>'
           '<li><a href="text/b.xhtml">Interlude</a></li>'
           '<li><a href="text/a.xhtml#c2">Chapter Two</a></li>')
    _write_epub(path, docs, nav_markup=nav)
    all_text = " ".join(section["text"] for section in parse_epub(path))
    assert all_text.count("UNIQUE-ALPHA") == 1
    assert all_text.count("UNIQUE-BETA") == 1
    assert all_text.count("UNIQUE-GAMMA") == 1


def test_epub_missing_anchor_does_not_steal_first_chapter(tmp_path):
    path = tmp_path / "missing-anchor.epub"
    member = "OPS/text/all.xhtml"
    doc = ('<html xmlns="http://www.w3.org/1999/xhtml"><body>'
           '<h2>Intro</h2><p>INTRO-BODY text here.</p>'
           '<h2 id="s2">Section Two</h2><p>SECTION-TWO-BODY text here.</p></body></html>')
    nav = ('<li><a href="text/all.xhtml">Intro</a></li>'
           '<li><a href="text/all.xhtml#s2">Section Two</a></li>'
           '<li><a href="text/all.xhtml#does_not_exist">Ghost</a></li>')
    _write_epub(path, {member: doc}, nav_markup=nav)
    by_title = {section["title"]: section["text"] for section in parse_epub(path)}
    assert "INTRO-BODY" in by_title["Intro"]
    assert "SECTION-TWO-BODY" in by_title["Section Two"]
    assert "Ghost" not in by_title


def test_anchor_offset_ignores_compound_attributes():
    import epub_parser
    html = '<p data-id="c1">decoy</p><h2 id="c1">real</h2>'
    offset = epub_parser._anchor_offset(html, "c1")
    assert offset is not None and html[offset:].startswith("<h2")


def test_epub_title_is_narrated_exactly_once(tmp_path):
    epub = tmp_path / "book.epub"
    make_test_epub(epub, num_chapters=2)
    for section in parse_epub(epub):
        assert section["text"].startswith(section["title"].rstrip(".") + ".")
        assert section["text"].count(section["title"]) == 1


def test_epub_metadata_does_not_resolve_external_entities(tmp_path):
    path = tmp_path / "external-entity.epub"
    doctype = '<!DOCTYPE package [<!ENTITY remote SYSTEM "http://127.0.0.1:9/unavailable">]>'
    _write_epub(path, {"OPS/text/chapter.xhtml": _chapter("Chapter", "safe body")},
                nav_markup='<li><a href="text/chapter.xhtml">Chapter</a></li>',
                opf_doctype=doctype, opf_title="&remote;")
    sections = parse_epub(path)
    assert len(sections) == 1
    assert "safe body" in sections[0]["text"]
    assert "127.0.0.1" not in sections[0]["title"]


def test_epub_parser_consumes_only_in_memory_vault_bytes(monkeypatch, tmp_path):
    import epub_parser
    archive_path = tmp_path / "fixture.epub"
    make_test_epub(archive_path, num_chapters=1)
    encrypted_store_path = Path("books/fixture.epub")
    received = []
    payload = archive_path.read_bytes()
    monkeypatch.setattr(epub_parser, "read_book_bytes",
                        lambda path: received.append(path) or payload)
    assert len(parse_epub(encrypted_store_path)) == 1
    assert received == [encrypted_store_path]


def test_invalid_epub_fails_with_value_error(tmp_path):
    path = tmp_path / "not-an-epub.epub"
    path.write_bytes(b"not a zip")
    with pytest.raises(ValueError, match="invalid EPUB archive"):
        parse_epub(path)
