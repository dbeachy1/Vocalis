"""The shipped route surface retains Speech source prep and Stems song sources."""

from flask import Flask

from vocalis.runtime import subsystems
from vocalis.web.train import create_train_blueprint
from vocalis.web.songs import create_song_library_blueprint


def _route_methods(blueprint):
    app = Flask(__name__, static_folder=None)
    app.register_blueprint(blueprint)
    return {(rule.rule, method) for rule in app.url_map.iter_rules()
            for method in rule.methods - {"HEAD", "OPTIONS"}}


def test_train_routes_keep_only_source_library_and_imports():
    routes = _route_methods(create_train_blueprint())
    assert routes == {
        ("/train/sources", "GET"), ("/train/sources", "POST"),
        ("/train/sources/<fname>/audio", "GET"),
        ("/train/sources/<fname>/enhanced", "GET"),
        ("/train/sources/<fname>/enhance", "POST"),
        ("/train/sources/rename", "POST"), ("/train/sources", "DELETE"),
        ("/train/import", "POST"), ("/train/import_scene", "POST"),
        ("/train/import_stem", "POST"), ("/train/import_stems_joined", "POST"),
    }


def test_shared_song_routes_remain_for_stems():
    routes = _route_methods(create_song_library_blueprint())
    assert routes == {
        ("/voiceswap/songs", "GET"), ("/voiceswap/songs", "POST"),
        ("/voiceswap/songs", "DELETE"),
        ("/voiceswap/songs/<source>/<fname>/audio", "GET"),
        ("/voiceswap/songs/<source>/<fname>/favorite", "POST"),
    }


def test_product_subsystem_rows_exclude_unshipped_workloads():
    rows = subsystems.rows_for_mode(docker_mode=True)
    keys = [row["key"] for row in rows]
    assert keys == [subsystems.RENDER, subsystems.VOICECREATE,
                    subsystems.STEMS, subsystems.ACESTEP]
    assert subsystems.capable("cuda:0", docker_mode=True) == keys
    assert subsystems.capable("satellite-a:cuda:0", docker_mode=True) == [
        subsystems.RENDER, subsystems.STEMS]
    assert subsystems.clean_uses(
        {subsystems.TRAINING: True, subsystems.SWAP: True, subsystems.STEMS: False}, "cuda:0",
        docker_mode=True) == {
            subsystems.STEMS: False}
    assert subsystems.TRAINING not in keys and subsystems.SWAP not in keys
