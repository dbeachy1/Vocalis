"""Checks on the license notices (packaging/licenses/NOTICE.md), the source records beside it, and the license texts
the image recipes install (October 11, 2026). No Docker and no network: they read the tracked files.

What they hold in place:
- every copyleft or source-requiring third-party component named in the notices has a source address in the notices,
  and every address and checksum in the notices is the one in a record;
- the Ubuntu source list carries the two packages the AMD images add;
- the GCC runtime library copies in the NumPy, SciPy, scikit-learn and PyTorch wheels are recorded by version;
- the files that ship carry no pointer to a work folder or document an outside reader does not have, and no internal
  status flag (the exceptions are listed, with the reason, in ACCEPTED_LEFTOVERS);
- the Dockerfiles copy the license texts the notices say are in the images.
"""

import json
import re
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1]
REPO = PACKAGING.parent
LICENSES = PACKAGING / "licenses"

NOTICE = (LICENSES / "NOTICE.md").read_text(encoding="utf-8")
ALLOWLIST = json.loads((PACKAGING / "source-offer" / "allowlist.json").read_text(encoding="utf-8"))["files"]
APT = json.loads((LICENSES / "apt-runtime-source-artifacts.json").read_text(encoding="utf-8"))
RUNTIME = json.loads((LICENSES / "runtime-source-artifacts.json").read_text(encoding="utf-8"))
NUMPY_SCIPY = json.loads((LICENSES / "numpy-scipy-native-source-artifacts.json").read_text(encoding="utf-8"))
SOUNDFILE = json.loads((LICENSES / "soundfile-native-source-artifacts.json").read_text(encoding="utf-8"))
SQLITE = json.loads((LICENSES / "taproom-sqlite-source-artifacts.json").read_text(encoding="utf-8"))
ROCM = json.loads((LICENSES / "rocm-notice-artifacts.json").read_text(encoding="utf-8"))
STEMS = json.loads((PACKAGING / "stems" / "source-artifacts.lock.json").read_text(encoding="utf-8"))
RECORD_TEXT = "\n".join(
    path.read_text(encoding="utf-8") for path in sorted(LICENSES.glob("*.json"))
) + (PACKAGING / "stems" / "source-artifacts.lock.json").read_text(encoding="utf-8")

MAIN_DOCKERFILE = (PACKAGING / "main-cuda" / "Dockerfile.app").read_text(encoding="utf-8")
TAPROOM_DOCKERFILE = (PACKAGING / "taproom" / "Dockerfile").read_text(encoding="utf-8")
SATELLITE_DOCKERFILE = (PACKAGING / "satellite" / "Dockerfile").read_text(encoding="utf-8")
SATELLITE_IGNORE = (PACKAGING / "satellite" / "Dockerfile.dockerignore").read_text(encoding="utf-8")
BUILD_CONTRACT = json.loads((PACKAGING / "main-app-build.json").read_text(encoding="utf-8"))


def section(heading):
    """The text of a '## heading' section of the notices, up to the next '## ' heading."""
    start = NOTICE.index(f"## {heading}\n")
    end = NOTICE.find("\n## ", start + 1)
    return NOTICE[start:end if end > 0 else len(NOTICE)]


SOURCES = section("Where to get the source of the third-party components")


# ---- item 2: the Ubuntu source list and the source locations -------------------------------------------------

def apt_rows(source, version):
    return [row for row in APT["sourceArtifacts"]
            if any(p["source"] == source and p["version"] == version for p in row["sourcePackages"])]


def test_the_two_amd_packages_have_rows_like_the_others():
    expected = {
        ("linux", "7.0.0-38.38"): {
            "linux_7.0.0-38.38.diff.gz": (3455370, "98e913d4a1c1f810e4dcfa573cbcf0f1a3a4427bdcd503722555298a794c52b2"),
            "linux_7.0.0-38.38.dsc": (7845, "016d43577bd8a61629a02e140e3b88072b5ccdd1c90cb1ce2f3c8e5c28756e7e"),
            "linux_7.0.0.orig.tar.gz": (254937830, "c6343795c8c7e4feff55f5b309365c8e0eaf49cd6abcb412e32315313f149536"),
        },
        ("rpcsvc-proto", "1.4.3-1build1"): {
            "rpcsvc-proto_1.4.3-1build1.debian.tar.xz": (4320, "6d047d3dfdebfe1030e7f27f52fc2ef0c28ce4e89a98b8ca5c2c927af26a015b"),
            "rpcsvc-proto_1.4.3-1build1.dsc": (2023, "ddfea3fbaadb6718a8d0fac4bd437831c09f7a1ec9144d0ebc112bc83bc2d77d"),
            "rpcsvc-proto_1.4.3.orig.tar.xz": (167964, "69315e94430f4e79c74d43422f4a36e6259e97e67e2677b2c7d7060436bd99b1"),
        },
    }
    reference = {key for row in APT["sourceArtifacts"] for key in row}
    for (source, version), files in expected.items():
        rows = {row["filename"]: row for row in apt_rows(source, version)}
        assert set(rows) == set(files), (source, version)
        for name, (size, sha) in files.items():
            row = rows[name]
            assert set(row) == reference == {"filename", "url", "bytes", "sha256", "sourcePackages"}
            assert (row["bytes"], row["sha256"]) == (size, sha)
            pool = row["sourcePackages"][0]["directory"]
            assert row["url"] == f"https://archive.ubuntu.com/ubuntu/{pool}/{name}"
            assert all(p["images"] == ["amd"] for p in row["sourcePackages"])
            assert all(set(p) == {"source", "version", "suiteComponent", "images", "directory"} for p in row["sourcePackages"])
    # The linux package is published in both -updates and -security; the other row set is main only.
    assert {p["suiteComponent"] for row in apt_rows("linux", "7.0.0-38.38") for p in row["sourcePackages"]} == {
        "resolute-updates-main", "resolute-security-main"}


def test_the_apt_record_counts_match_its_rows_and_the_rows_are_sorted():
    rows = APT["sourceArtifacts"]
    assert [r["filename"] for r in rows] == sorted((r["filename"] for r in rows), key=lambda v: v.encode("utf-8"))
    assert APT["scope"]["uniqueArchiveFileCount"] == len(rows)
    assert APT["scope"]["totalCompressedBytes"] == sum(r["bytes"] for r in rows)
    assert APT["scope"]["sourceVersionCount"] == len({(p["source"], p["version"]) for r in rows for p in r["sourcePackages"]})
    for row in rows:
        assert re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), row["filename"]
        assert row["url"] == "https://archive.ubuntu.com/ubuntu/" + row["sourcePackages"][0]["directory"] + "/" + row["filename"]


def test_the_notices_say_how_to_fetch_an_ubuntu_source_package_and_name_the_amd_additions():
    ubuntu = SOURCES[SOURCES.index("### Ubuntu packages"):]
    for needed in ("apt-runtime-source-artifacts.json", "apt-get source", "launchpad.net/ubuntu/+source/",
                   "dpkg-query -W -f='${source:Package} ${source:Version}", "linux-libc-dev", "rpcsvc-proto",
                   "7.0.0-38.38", "1.4.3-1build1", "archive.ubuntu.com"):
        assert needed in ubuntu, needed
    assert "that the file does not list" not in NOTICE


def test_every_address_and_checksum_in_the_source_tables_is_in_a_record():
    # Generic locations that are not one record entry: Ubuntu's archive and Launchpad pages and GCC's public tree.
    generic = ("https://archive.ubuntu.com/", "https://launchpad.net/ubuntu/+source/", "https://gcc.gnu.org/git/",
               "https://ftp.gnu.org/gnu/gcc/", "https://www.mpg123.org/download/")
    for url in re.findall(r"<(https?://[^>\s]+)>", SOURCES):
        assert url in RECORD_TEXT or url.startswith(generic) or url.rstrip("/") in RECORD_TEXT or url.split(";f=")[0] in RECORD_TEXT, url
    for digest in re.findall(r"`([0-9a-f]{64})`", SOURCES):
        assert digest in RECORD_TEXT, digest
    for integrity in re.findall(r"`(sha512-[A-Za-z0-9+/=]+)`", SOURCES):
        assert integrity in RECORD_TEXT


def test_every_source_entry_of_every_record_is_in_the_source_tables():
    expected = []
    expected += [a["url"] for a in RUNTIME["sourceArtifacts"]]
    expected += [a["url"] for a in SOUNDFILE["sourceArtifacts"]]
    expected += [SOUNDFILE["scope"]["upstreamSource"], SOUNDFILE["scope"]["submodule"]["files"][0]["url"]]
    expected += [a["url"] for a in SQLITE["artifacts"]]
    expected += [SQLITE["databaseSource"]["cipherSourceUrl"], SQLITE["vectorSource"]["upstreamSourceUrl"]]
    expected += [a["url"] for a in NUMPY_SCIPY["scope"]["sourceArtifacts"]]
    expected += [w["sourceRelease"]["url"] for w in NUMPY_SCIPY["scope"]["wheels"]]
    expected += list(ROCM["sourceRepositories"].values())
    expected += [STEMS["runtimeGraph"]["lameenc"]["archiveUrl"], STEMS["runtimeGraph"]["lame"]["url"]]
    missing = [url for url in expected if url not in SOURCES]
    assert missing == []


@pytest.mark.parametrize("name", [
    "soxr 1.1.0", "libsndfile 1.2.2", "LAME", "mpg123", "libogg", "libvorbis", "FLAC", "Opus", "lameenc 1.8.4",
    "frozendict 2.4.7", "ip-matching 2.1.2", "libgfortran", "libquadmath", "libgomp", "certifi", "tqdm", "orjson",
    "dompurify 3.4.2", "better-sqlite3-multiple-ciphers 12.11.1", "sqlite-vec 0.1.9", "SQLite3 Multiple Ciphers 2.3.5",
    "AMD ROCm 7.14.1", "numpy-2.5.3", "scipy-1.18.1", "numpy-2.3.5", "scipy-1.17.0", "scikit-learn-1.9.1",
    "Ubuntu packages",
])
def test_each_component_the_notice_tables_name_has_a_source_entry(name):
    assert name in SOURCES, name


def test_the_notice_text_for_the_release_has_no_status_wording():
    for phrase in (r"\bpending\b", "next build", "from the next", "delivery pending", r"\bnot yet\b", r"\bwill be\b", "TODO"):
        assert not re.search(phrase, NOTICE), phrase
    assert "releaseReady" not in NOTICE
    assert ".codex" not in NOTICE and "docs/" not in NOTICE


def test_the_notices_carry_the_satellite_line_and_the_license_texts_in_the_images():
    assert "the satellite image (NVIDIA and AMD) carries the same LGPL libraries as the main image" in NOTICE
    assert "their source locations are in this same document" in NOTICE
    texts = section("Other copyleft and notice-requiring components in the images")
    for needed in ("GPL-3.0.txt", "LGPL-2.1.txt", "LGPL-3.0.txt", "/usr/share/licenses/vocalis-g1/", "sqlite/",
                   "/usr/share/licenses/vocalis-g1/rocm/", "/usr/share/licenses/vocalis/stems/rocm/"):
        assert needed in texts, needed
    assert "https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz" in NOTICE


# ---- item 6: the NumPy / SciPy / scikit-learn / PyTorch library copies ---------------------------------------

def test_the_wheel_library_record_names_the_versions_in_the_images():
    names = {w["name"].split("-cp312")[0] for w in NUMPY_SCIPY["scope"]["wheels"]}
    assert names == {"numpy-1.26.4", "scipy-1.17.1", "numpy-2.3.5", "scipy-1.17.0", "numpy-2.5.3", "scipy-1.18.1", "scikit_learn-1.9.1"}
    for wheel in NUMPY_SCIPY["scope"]["wheels"]:
        assert re.fullmatch(r"[0-9a-f]{64}", wheel["sha256"])
        release = wheel["sourceRelease"]
        assert release["url"].startswith("https://files.pythonhosted.org/") and re.fullmatch(r"[0-9a-f]{64}", release["sha256"])
    objects = {(o["library"], o["buildId"]) for o in NUMPY_SCIPY["scope"]["runtimeObjects"]}
    for expected in (("libgfortran", "04dbe32dceb80654422140fb7641f732065999c8"),
                     ("libquadmath", "c1c5f8d61f17e5579c4e85718845b74e4b94116c"),
                     ("libgfortran", "7a1cb85776f57993d3677ea0c447549a8cfec097"),
                     ("libquadmath", "84f2ad8237013ef80f316c581f675e4dc1b483bd"),
                     ("libgomp", "2244452c1de4759ccb52adc5352b501d4c2ee9ce"),
                     ("libgomp", "5f4fb88af97be3ecacc71363136bb015b2a07119")):
        assert expected in objects, expected


def test_every_recorded_library_copy_has_a_source_package_or_a_public_location():
    artifacts = {a["name"]: a for a in NUMPY_SCIPY["scope"]["sourceArtifacts"]}
    for obj in NUMPY_SCIPY["scope"]["runtimeObjects"]:
        if "sourceArtifact" in obj:
            assert obj["sourceArtifact"] in artifacts, obj["buildId"]
        elif "mappedCandidate" in obj:
            assert any(a["supports"].startswith(obj["mappedCandidate"].split("-")[0]) for a in artifacts.values()), obj["buildId"]
        else:
            assert obj["publicSourceLocation"].startswith("https://gcc.gnu.org/git/"), obj["buildId"]
    for artifact in artifacts.values():
        assert re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]) and artifact["url"].startswith("https://")
    assert "gcc-8.5.0-28.el8_10.alma.1.src.rpm" in artifacts and "gcc-8.5.0-26.el8_10.alma.1.src.rpm" in artifacts


# ---- item 3: nothing that ships points at what an outside reader does not have --------------------------------

# Files that still name the private work folder or a design document, each for a reason that is not a defect in the
# notices: the first three groups are build inputs that scripts read or that hash-pinned records cover (changing them
# changes a frozen build input, a decision for the owner), the last two are code comments and code defaults.
ACCEPTED_LEFTOVERS = (
    "packaging/acestep/",                    # frozen ACE-Step engine inputs; their SHA-256 values are pinned in engine-build-inputs.json and the Dockerfile labels
    "packaging/models/acestep/",             # the ACE-Step model lock and acquisition record, pinned by that chain
    "packaging/trim/Dockerfile",             # build recipe paths (the build scripts' inputs)
    "packaging/licenses/rocm/",              # third-party license texts, unchanged
)
SHIPPED_DOCUMENT_SUFFIXES = {".md", ".json", ".txt"}
FORBIDDEN = [
    (re.compile(r"\.codex"), "a path into the private work folder"),
    (re.compile(r"(?<![\w./-])docs/[A-Za-z]"), "a pointer to a document that is not shipped"),
    (re.compile(r"Retained-Model-License-Questions"), "a pointer to an internal document"),
    (re.compile(r'"?(?:releaseReady|sourceArchivesAreReleaseReady)"?\s*:'), "an internal status flag"),
    (re.compile(r"pending-recipient-accessible-delivery|delivery pending"), "an internal delivery status"),
]


def _shipped_documents():
    for relative in ALLOWLIST:
        path = Path(relative)
        if path.suffix not in SHIPPED_DOCUMENT_SUFFIXES:
            continue
        if not (relative.startswith("packaging/") or relative in ("README.md", "LICENSE")):
            continue
        # Lock-file comment headers and wheelhouse manifests are build inputs, not documents.
        if relative.endswith(".lock") or relative.startswith(ACCEPTED_LEFTOVERS):
            continue
        if relative.startswith(("packaging/windows/", "packaging/satellite/", "packaging/tests/")):
            continue  # installer, satellite and test sources are outside this check
        yield relative


def test_the_shipped_documents_and_records_point_at_nothing_an_outside_reader_lacks():
    found = []
    for relative in _shipped_documents():
        text = (REPO / relative).read_text(encoding="utf-8", errors="replace")
        if relative == "packaging/README.md":
            # The one document that explains, in its last section, why lock and manifest files here name .codex/ paths.
            heading = "## Build inputs gathered outside the repository"
            assert heading in text and ".codex" in text.split(heading)[1], "the explanation must stay in the README"
            text = text.split(heading)[0]
        for pattern, why in FORBIDDEN:
            for match in pattern.finditer(text):
                found.append(f"{relative}: {match.group(0)!r} ({why})")
    assert found == []


def test_the_root_readme_and_license_are_covered_by_that_check():
    files = list(_shipped_documents())
    assert "README.md" in files and "packaging/licenses/NOTICE.md" in files
    assert "packaging/licenses/runtime-source-artifacts.json" in files and "packaging/models/dfn3/NOTICE.md" in files
    assert "packaging/source-offer/README.md" in files


def test_old_development_image_ids_are_not_presented_in_the_license_records():
    old = ("4f4f91e05e8c5881d5f9ecc82f948e3da367b5134746e1851fd27450b0654542", "e246b2a385489e8ad9c512a2319492740d12a920e5395cc6541a93f31c6ef5b2",
           "a73bc7ef8caab8489cc60b81051b5badfc04be53369358cc572b148652bd43a7", "0788ef4d6eb715938958e4bbff4380469d07e2f144b063a521a5d63271caef33",
           "cad73e91e98ca3015081611bf488e985a2eaa13a8f9dc218970829aa6feca159", "83b5e55b9e37a691f04d3e3fbe5f6e9baf178713829857b78e565e831a4f4ac1",
           "c9e18606db6407b41bae716a38715cede77edcab8720d35de03667e830ec41e8")
    for digest in old:
        assert digest not in RECORD_TEXT and digest not in NOTICE, digest


def test_the_historical_rows_for_libraries_that_are_not_installed_are_gone_from_the_records():
    names = {a["name"] for a in RUNTIME["sourceArtifacts"]}
    assert "EbookLib" not in names and "pykakasi" not in names
    # The notices keep the sentence that says they were replaced.
    assert "EbookLib is not installed in any image" in NOTICE and "pykakasi is not installed in any image" in NOTICE


# ---- item 4: the license texts the images carry --------------------------------------------------------------

def test_the_main_image_copies_the_three_gnu_license_texts():
    for name in ("GPL-3.0.txt", "LGPL-2.1.txt", "LGPL-3.0.txt"):
        assert f"COPY --from=license-texts /{name} /usr/share/licenses/vocalis-g1/{name}\n" in MAIN_DOCKERFILE, name
        assert (LICENSES / name).is_file()
        assert f"packaging/licenses/{name}" in BUILD_CONTRACT["sourceInputs"], name
    assert BUILD_CONTRACT["directoryContexts"]["license-texts"] == "packaging/licenses"


def test_the_taproom_image_copies_the_lgpl_gpl_and_sqlite_texts():
    expected = {
        "/payload/packaging/licenses/LGPL-3.0.txt": "/usr/share/licenses/vocalis-g1/LGPL-3.0.txt",
        "/payload/packaging/licenses/GPL-3.0.txt": "/usr/share/licenses/vocalis-g1/GPL-3.0.txt",
        "/payload/packaging/licenses/sqlite/": "/usr/share/licenses/vocalis-g1/sqlite/",
    }
    copies = dict(re.findall(r"^COPY --from=taproom-source (\S+) (\S+)$", TAPROOM_DOCKERFILE, re.MULTILINE))
    for source, target in expected.items():
        assert copies.get(source) == target, source
        relative = source[len("/payload/"):]
        assert (REPO / relative).exists() and (relative.rstrip("/") in ALLOWLIST or any(f.startswith(relative) for f in ALLOWLIST))
    for name in ("sqlite-vec-MIT.txt", "sqlite-vec-Apache-2.0.txt", "sqlite3mc-embedded-notices.txt"):
        assert f"packaging/licenses/sqlite/{name}" in ALLOWLIST


def test_the_satellite_image_carries_lgpl_2_1_and_the_amd_image_the_rocm_notices():
    assert "RUN --mount=type=bind,source=packaging/licenses,target=/lic" in SATELLITE_DOCKERFILE
    assert "install -D -m 0444 /lic/LGPL-2.1.txt /usr/share/licenses/vocalis-g1/LGPL-2.1.txt" in SATELLITE_DOCKERFILE
    assert "install -D -m 0444 /lic/GPL-3.0.txt /usr/share/licenses/vocalis-g1/GPL-3.0.txt" in SATELLITE_DOCKERFILE
    rocm = SATELLITE_DOCKERFILE[SATELLITE_DOCKERFILE.index("rocm) mkdir -p"):SATELLITE_DOCKERFILE.index("cuda) echo")]
    assert "cp -a /lic/rocm/. /usr/share/licenses/vocalis-g1/rocm/" in rocm
    assert "/lic/rocm-notice-artifacts.json" in rocm and "chmod -R a-w" in rocm
    assert "GPU_TYPE must be cuda or rocm" in SATELLITE_DOCKERFILE[SATELLITE_DOCKERFILE.index("/lic"):]
    admitted = {line[1:] for line in SATELLITE_IGNORE.splitlines() if line.startswith("!")}
    assert {"packaging/licenses/", "packaging/licenses/LGPL-2.1.txt", "packaging/licenses/GPL-3.0.txt", "packaging/licenses/rocm-notice-artifacts.json",
            "packaging/licenses/rocm/", "packaging/licenses/rocm/*"} <= admitted
    # The ROCm notices are the same files the AMD main image carries (collected by the Stems recipe from this folder).
    stems = (PACKAGING / "stems" / "Dockerfile").read_text(encoding="utf-8")
    assert "cp -a /rocm-notices/rocm/. /usr/share/licenses/vocalis/stems/rocm/" in stems
    assert sorted(p.name for p in (LICENSES / "rocm").iterdir())  # the notices exist to be copied


def test_the_main_dockerfile_still_checks_the_ffmpeg_hash_the_contexts_step_verifies():
    contract = json.loads((PACKAGING / "ffmpeg" / "build-contract.json").read_text(encoding="utf-8"))
    assert contract["source"]["sha256"] in MAIN_DOCKERFILE
    record = json.loads((LICENSES / "ffmpeg-source-artifacts.json").read_text(encoding="utf-8"))
    official = record["scope"]["officialRelease"]
    assert official["url"] == contract["source"]["url"] and official["sha256"] == contract["source"]["sha256"]
    ubuntu_orig = [f for f in record["sourceFiles"] if f["filename"] == "ffmpeg_8.0.1.orig.tar.xz"][0]
    assert (ubuntu_orig["sha256"], ubuntu_orig["bytes"]) == (official["sha256"], official["bytes"])
