"""Tests avatar-thumbnail generation, caching, and fallback behavior."""
from __future__ import annotations

import copy
import io
import json
import struct
import zlib

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault_fs
import vocalis.web.wbedit as web_wbedit
import vocalis_server as vs
from vocalis.runtime import paths
from wbedit import thumbs
from wbedit.formats import png_card
from wbedit.store import AVATAR, DocumentStore, MissingDocument

PIL = pytest.importorskip("PIL.Image", reason="Pillow is a declared dependency of this product")

CARD = {
    "spec": "chara_card_v2", "spec_version": "2.0",
    "data": {"name": "Test Character 2", "description": "A tall woman.", "personality": "Wry.",
             "scenario": "A tavern.", "first_mes": "You again.", "mes_example": "<START>"},
}


def a_real_png(w: int = 200, h: int = 300, color=(200, 40, 40)) -> bytes:
    """A valid, decodable PNG used to exercise the thumbnail decoder."""
    im = PIL.new("RGB", (w, h), color)
    # A distinguishable quadrant, so a crop that lands in the wrong place is visible as a color
    # rather than having to be believed.
    for x in range(w // 2):
        for y in range(h // 2):
            im.putpixel((x, y), (20, 20, 220))
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def a_card(store, png=None):
    doc = store.create(copy.deepcopy(CARD), name="Test Character 2", kind="card")
    store.put_asset(doc.id, AVATAR, png or a_real_png())
    return doc


def _thumbs_on_disk(store, doc_id):
    return sorted(vault_fs.glob(store._assets(doc_id), f"{thumbs.PREFIX}*{thumbs.SUFFIX}"))


def _chunk(ctype: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + ctype + data
            + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))


def an_undecodable_png() -> bytes:
    """A structurally valid PNG with invalid compressed image data."""
    return (png_card.PNG_SIGNATURE
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", b"this is definitely not a zlib stream")
            + _chunk(b"IEND", b""))


# ── the key: BOTH inputs ─────────────────────────────────────────────────────

def test_the_key_moves_when_the_image_moves():
    a = thumbs.key(1000, 1.0, {})
    assert thumbs.key(1001, 1.0, {}) != a, "a different size must be a different thumbnail"
    assert thumbs.key(1000, 2.0, {}) != a, "a different mtime must be a different thumbnail"


def test_the_key_moves_when_the_CLIPPED_AREA_moves():
    """Checks that the key moves when the clipped area moves."""
    same_image = (1000, 1.0)
    a = thumbs.key(*same_image, {"x": 0.1, "y": 0.2, "w": 0.5})
    for moved in ({"x": 0.11, "y": 0.2, "w": 0.5},
                  {"x": 0.1, "y": 0.21, "w": 0.5},
                  {"x": 0.1, "y": 0.2, "w": 0.51}):
        assert thumbs.key(*same_image, moved) != a, f"{moved} must rebuild"
    assert thumbs.key(*same_image, {}) != a, "no rect at all is a different crop again"


def test_the_key_moves_when_the_OUTPUT_SIZE_moves():
    """`px` is a constant today. The day it is not, a cache of the old size would be
    indistinguishable from a fresh one."""
    assert thumbs.key(1000, 1.0, {}, 96) != thumbs.key(1000, 1.0, {}, 128)


def test_a_float_wobble_in_the_rect_is_not_a_rebuild():
    """Checks that a float wobble in the rect is not a rebuild."""
    a = thumbs.key(1000, 1.0, {"x": 0.1, "y": 0.2, "w": 0.5})
    b = thumbs.key(1000, 1.0, {"x": 0.1 + 1e-12, "y": 0.2, "w": 0.5})
    assert a == b


def test_the_key_is_a_safe_filename():
    """It becomes an asset name, and `put_asset` refuses a separator — better to know here."""
    k = thumbs.key(1000, 1.0, {"x": 0.1, "y": 0.2, "w": 0.5})
    assert k.isalnum() and len(k) == 16
    assert thumbs.asset_name(k) == f"thumb-{k}.webp"


# ── the crop math, which has to agree with the browser's ────────────────────

def test_no_rect_is_the_largest_centered_square():
    assert thumbs.crop_box(200, 300, {}) == (0, 50, 200, 250)
    assert thumbs.crop_box(300, 200, None) == (50, 0, 250, 200)


def test_a_rect_is_read_as_FRACTIONS_of_the_source():
    """Checks that a rect is read as fractions of the source."""
    assert thumbs.crop_box(200, 300, {"x": 0.5, "y": 0.0, "w": 0.5}) == (100, 0, 200, 100)


def test_a_rect_pointing_outside_the_image_is_clamped_like_the_browsers():
    """Checks that a rect pointing outside the image is clamped like the browsers."""
    left, top, right, bottom = thumbs.crop_box(200, 300, {"x": 0.9, "y": 0.9, "w": 0.9})
    assert 0 <= left and 0 <= top and right <= 200 and bottom <= 300
    assert right - left == bottom - top, "the crop must stay square"


# ── rendering ────────────────────────────────────────────────────────────────

def test_a_thumbnail_is_a_square_webp_of_the_declared_size():
    blob = thumbs.render(a_real_png(200, 300), {})
    assert blob[:4] == b"RIFF" and blob[8:12] == b"WEBP"
    with PIL.open(io.BytesIO(blob)) as im:
        assert im.size == (thumbs.THUMB_PX, thumbs.THUMB_PX)


def test_the_rect_is_APPLIED_not_merely_recorded():
    """Checks that the rect is applied not merely recorded."""
    def middle(blob):
        with PIL.open(io.BytesIO(blob)) as im:
            return im.convert("RGB").getpixel((im.width // 2, im.height // 2))

    src = a_real_png(200, 300)
    blue = middle(thumbs.render(src, {"x": 0.0, "y": 0.0, "w": 0.4}))
    red = middle(thumbs.render(src, {"x": 0.55, "y": 0.6, "w": 0.4}))
    assert blue[2] > blue[0], f"the top-left crop should be blue, got {blue}"
    assert red[0] > red[2], f"the bottom-right crop should be red, got {red}"


def test_transparency_survives_rather_than_becoming_a_black_square():
    """A card cut out of its background must not gain a box behind it in the roster."""
    im = PIL.new("RGBA", (100, 100), (255, 0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    with PIL.open(io.BytesIO(thumbs.render(buf.getvalue(), {}))) as out:
        assert out.mode in ("RGBA", "LA", "P"), f"alpha was dropped: {out.mode}"
        assert out.convert("RGBA").getpixel((48, 48))[3] == 0


def test_a_palette_image_is_converted_before_it_is_resized():
    """Checks that a palette image is converted before it is resized."""
    im = PIL.new("P", (120, 120))
    im.putpalette([0, 0, 0] + [10, 200, 30] * 255)
    im.paste(1, (0, 0, 120, 120))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    with PIL.open(io.BytesIO(thumbs.render(buf.getvalue(), {}))) as out:
        r, g, b = out.convert("RGB").getpixel((48, 48))
        assert g > r and g > b, f"a flat green palette image came out {(r, g, b)}"


def test_rubbish_raises_ThumbFailed_rather_than_whatever_Pillow_felt_like():
    """The route turns exactly this into a 415 and the browser falls back. An unclassified
    exception would become a 500 and the row would lose its face."""
    with pytest.raises(thumbs.ThumbFailed):
        thumbs.render(b"this is not an image", {})


def test_a_structurally_real_png_that_cannot_decode_also_degrades():
    """Correct signature, correct chunks, undecodable pixels — which is the realistic shape of
    this failure and the one that would otherwise reach the route as a 500."""
    with pytest.raises(thumbs.ThumbFailed):
        thumbs.render(an_undecodable_png(), {})


def test_the_suites_own_minimal_png_decodes_FINE():
    """Checks that the suites own minimal png decodes fine."""
    blob = (png_card.PNG_SIGNATURE
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + _chunk(b"IEND", b""))
    out = thumbs.render(blob, {})
    with PIL.open(io.BytesIO(out)) as im:
        assert im.size == (thumbs.THUMB_PX, thumbs.THUMB_PX)


# ── the store: build on miss, sweep the superseded ───────────────────────────

def test_the_first_ask_builds_it_and_the_second_does_not(store, monkeypatch):
    doc = a_card(store)
    blob, key = store.thumbnail(doc.id)
    assert _thumbs_on_disk(store, doc.id) == [thumbs.asset_name(key)]

    calls = []
    real = thumbs.render
    monkeypatch.setattr(thumbs, "render", lambda *a, **k: calls.append(1) or real(*a, **k))
    again, key2 = store.thumbnail(doc.id)
    assert (again, key2) == (blob, key) and not calls, "a hit must not decode the PNG again"


def test_moving_the_FACE_SQUARE_rebuilds_it(store):
    """Checks that moving the face square rebuilds it."""
    doc = a_card(store)
    _, first = store.thumbnail(doc.id)
    store.set_focus(doc.id, {"x": 0.5, "y": 0.5, "w": 0.4})
    second_blob, second = store.thumbnail(doc.id)
    assert second != first, "a moved rect must mint a different cache key"
    assert _thumbs_on_disk(store, doc.id) == [thumbs.asset_name(second)], \
        "and the superseded crop must not be left in the store"
    assert second_blob == thumbs.render(store.asset(doc.id, AVATAR),
                                        store.get(doc.id).focus)


def test_replacing_the_PICTURE_rebuilds_it(store):
    doc = a_card(store)
    _, first = store.thumbnail(doc.id)
    store.put_avatar(doc.id, a_real_png(200, 300, color=(10, 180, 10)))
    assert _thumbs_on_disk(store, doc.id) == [], "put_avatar drops the dead crops immediately"
    _, second = store.thumbnail(doc.id)
    assert second != first


def test_a_document_with_no_picture_is_a_MissingDocument(store):
    doc = store.create(copy.deepcopy(CARD), name="Faceless", kind="card")
    with pytest.raises(MissingDocument):
        store.thumbnail(doc.id)


def test_the_cache_is_written_through_the_vault_like_everything_else(store):
    """Checks that the cache is written through the vault like everything else."""
    doc = a_card(store)
    _, key = store.thumbnail(doc.id)
    assert vault_fs.exists(store._assets(doc.id) / thumbs.asset_name(key))
    assert store._assets(doc.id).is_relative_to(store._dir(doc.id))


def test_the_stored_picture_is_never_touched(store):
    """§4.3 is unchanged: the card PNG is the avatar and goes out whole. The thumbnail is a
    DERIVED extra and the original is read for nothing else."""
    doc = a_card(store)
    before = store.asset(doc.id, AVATAR)
    store.thumbnail(doc.id)
    store.set_focus(doc.id, {"x": 0.2, "y": 0.2, "w": 0.3})
    store.thumbnail(doc.id)
    assert store.asset(doc.id, AVATAR) == before


# ── the route ────────────────────────────────────────────────────────────────

def _import_card(c, png=None):
    r = c.post("/wbedit/documents", json={"document": CARD, "name": "Test Character 2"})
    doc = r.get_json()
    c.post(f"/wbedit/documents/{doc['id']}/avatar", data=png or a_real_png(),
           content_type="image/png")
    return doc


def test_the_route_serves_a_webp_and_a_conditional_request_gets_a_304(client):
    doc = _import_card(client)
    r = client.get(f"/wbedit/documents/{doc['id']}/thumb")
    assert r.status_code == 200 and r.mimetype == "image/webp"
    assert len(r.data) < 20_000, f"a 96px crop should be small, got {len(r.data)}"
    again = client.get(f"/wbedit/documents/{doc['id']}/thumb",
                       headers={"If-None-Match": r.headers["ETag"]})
    assert again.status_code == 304 and not again.data


def test_the_ETag_moves_when_the_face_square_moves(client):
    """The conditional request must handle both replacement inputs correctly."""
    doc = _import_card(client)
    first = client.get(f"/wbedit/documents/{doc['id']}/thumb").headers["ETag"]
    client.post(f"/wbedit/documents/{doc['id']}/focus",
                json={"focus": {"x": 0.4, "y": 0.4, "w": 0.3}})
    r = client.get(f"/wbedit/documents/{doc['id']}/thumb",
                   headers={"If-None-Match": first})
    assert r.status_code == 200, "a moved rect must not be answered from the browser's cache"
    assert r.headers["ETag"] != first


def test_the_route_never_lets_a_browser_hold_a_stale_crop(client):
    """Checks that the route never lets a browser hold a stale crop."""
    doc = _import_card(client)
    cc = client.get(f"/wbedit/documents/{doc['id']}/thumb").headers["Cache-Control"]
    assert "private" in cc, "a face out of an encrypted store must not reach a shared proxy"
    assert "no-cache" in cc and "max-age" not in cc


def test_an_undecodable_image_is_a_415_and_the_avatar_still_serves(client):
    """Checks that an undecodable image is a 415 and the avatar still serves."""
    junk = an_undecodable_png()
    doc = _import_card(client, junk)
    r = client.get(f"/wbedit/documents/{doc['id']}/thumb")
    assert r.status_code == 415
    full = client.get(f"/wbedit/documents/{doc['id']}/avatar")
    assert full.status_code == 200 and full.data == junk


def test_a_document_with_no_picture_404s(client):
    r = client.post("/wbedit/documents", json={"document": CARD, "name": "Faceless"})
    assert client.get(f"/wbedit/documents/{r.get_json()['id']}/thumb").status_code == 404



def test_the_roster_row_carries_the_thumbnails_cache_key(client):
    doc = _import_card(client)
    row = next(d for d in client.get("/wbedit/documents").get_json()["documents"]
               if d["id"] == doc["id"])
    tag = client.get(f"/wbedit/documents/{doc['id']}/thumb").headers["ETag"]
    assert row["thumb_at"], "the roster face has no token to put in its URL"
    assert row["thumb_at"] in tag, (row["thumb_at"], tag)
    one = client.get(f"/wbedit/documents/{doc['id']}").get_json()
    assert one["thumb_at"] == row["thumb_at"], "the roster and the document must agree"


def test_a_document_with_no_picture_has_an_empty_thumb_stamp(client):
    """`""`, never a token for a picture that does not exist — the renderer tests it for falsiness
    and would otherwise hang a `?v=` off a URL that 404s."""
    r = client.post("/wbedit/documents", json={"document": CARD, "name": "Faceless"})
    row = next(d for d in client.get("/wbedit/documents").get_json()["documents"]
               if d["id"] == r.get_json()["id"])
    assert row["thumb_at"] == "" and row["avatar_at"] == ""


def test_the_stamp_moves_when_the_PICTURE_is_replaced(client):
    doc = _import_card(client)
    before = next(d for d in client.get("/wbedit/documents").get_json()["documents"]
                  if d["id"] == doc["id"])["thumb_at"]
    client.post(f"/wbedit/documents/{doc['id']}/avatar",
                data=a_real_png(color=(10, 180, 10)), content_type="image/png")
    after = next(d for d in client.get("/wbedit/documents").get_json()["documents"]
                 if d["id"] == doc["id"])["thumb_at"]
    assert after != before


def test_the_stamp_moves_when_the_FACE_SQUARE_moves_and_avatar_at_DOES_NOT(client):
    """Checks that the stamp moves when the face square moves and avatar at does not."""
    doc = _import_card(client)

    def row():
        return next(d for d in client.get("/wbedit/documents").get_json()["documents"]
                    if d["id"] == doc["id"])

    before = row()
    client.post(f"/wbedit/documents/{doc['id']}/focus",
                json={"focus": {"x": 0.4, "y": 0.4, "w": 0.3}})
    after = row()
    assert after["avatar_at"] == before["avatar_at"], \
        "the picture did not change, and the avatar's stamp must say so"
    assert after["thumb_at"] != before["thumb_at"], \
        "but the crop did, and only the thumbnail's own key can see it"


def test_the_thumb_is_far_smaller_than_the_avatar_it_came_from(client):
    """Checks that the thumb is far smaller than the avatar it came from."""
    big = a_real_png(1024, 1536)
    doc = _import_card(client, big)
    thumb = client.get(f"/wbedit/documents/{doc['id']}/thumb").data
    assert len(thumb) * 20 < len(big), \
        f"thumb {len(thumb)}B vs avatar {len(big)}B — not worth a cache"
