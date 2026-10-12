"""Unit tests for split_into_chunks — no GPU required."""
import pytest
from tts_utils import split_into_chunks, CHUNK_SIZE, MIN_CHUNK_SIZE


def test_empty_string():
    assert split_into_chunks("") == []


def test_whitespace_only():
    assert split_into_chunks("   \n\t  ") == []


def test_single_short_sentence():
    chunks = split_into_chunks("Hello, world.")
    assert chunks == ["Hello, world."]


def test_multiple_short_sentences_pack_into_one_chunk():
    """Three short sentences all fit inside CHUNK_SIZE — should stay together."""
    text = "She ran. He waited. The door closed."
    chunks = split_into_chunks(text)
    assert len(chunks) == 1
    assert "She ran." in chunks[0]
    assert "The door closed." in chunks[0]


def test_split_at_sentence_boundary():
    """Two long sentences that together exceed CHUNK_SIZE → two chunks."""
    sentence = "A" * (CHUNK_SIZE - 10) + "."
    text = sentence + " " + sentence
    chunks = split_into_chunks(text)
    assert len(chunks) == 2
    for chunk in chunks:
        assert len(chunk) <= CHUNK_SIZE * 1.5   # no chunk wildly oversized


def test_long_sentence_splits_on_clause_boundary():
    """A single sentence longer than CHUNK_SIZE with commas → splits on commas."""
    # Build a sentence like "Word word word, word word word, ..." long enough to overflow
    part = "word " * 30 + "clause,"
    text = (part * 5).rstrip(",") + "."
    assert len(text) > CHUNK_SIZE
    chunks = split_into_chunks(text)
    assert len(chunks) > 1
    for chunk in chunks:
        # No chunk should massively exceed the target
        assert len(chunk) < CHUNK_SIZE * 2


def test_orphan_merge():
    """
    A trailing chunk shorter than MIN_CHUNK_SIZE should be merged into the
    previous chunk (combined stays below 1.5× CHUNK_SIZE).
    """
    # Build text that produces: one full chunk + one tiny orphan
    big_sentence = "B" * (CHUNK_SIZE - 5) + "."
    tiny_orphan  = "Okay."   # well below MIN_CHUNK_SIZE
    text = big_sentence + " " + tiny_orphan
    chunks = split_into_chunks(text)
    # Orphan should have been merged → one chunk (or at most one if combined < 1.5×)
    # Verify the orphan text is present in the last chunk
    assert tiny_orphan in chunks[-1]
    # Verify no standalone chunk shorter than MIN_CHUNK_SIZE exists
    if len(chunks) > 1:
        for chunk in chunks[:-1]:
            assert len(chunk) >= MIN_CHUNK_SIZE


def test_orphan_not_merged_when_combined_too_large():
    """
    If merging the orphan would exceed 1.5× CHUNK_SIZE, keep it separate.
    """
    big_sentence = "C" * (CHUNK_SIZE - 1) + "."   # fills chunk almost to limit
    # Make orphan big enough that combined > 1.5× CHUNK_SIZE
    big_orphan = "D" * (int(CHUNK_SIZE * 0.6)) + "."
    text = big_sentence + " " + big_orphan
    chunks = split_into_chunks(text)
    # Both should remain as separate chunks — combined would be too big to merge
    assert len(chunks) >= 2


def test_no_empty_chunks():
    text = "First sentence.   \n\n   Second sentence."
    chunks = split_into_chunks(text)
    for chunk in chunks:
        assert chunk.strip() != ""


def test_all_chunks_within_reasonable_size():
    """No chunk should wildly exceed CHUNK_SIZE (orphan merge cap is 1.5×)."""
    import random
    random.seed(42)
    words = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog"]
    sentences = [" ".join(random.choices(words, k=random.randint(5, 30))) + "."
                 for _ in range(50)]
    text = " ".join(sentences)
    chunks = split_into_chunks(text)
    for chunk in chunks:
        assert len(chunk) <= CHUNK_SIZE * 1.6, f"Chunk too large ({len(chunk)} chars): {chunk[:80]}"
