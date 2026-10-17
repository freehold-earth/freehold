from pathlib import Path

from pci_preimage.generate_vectors import build_vectors, main, render

VECTORS_PATH = (
    Path(__file__).resolve().parents[1] / "schemas" / "encoding" / "v1.0" / "test-vectors.json"
)


def test_generator_reproduces_committed_vector_file() -> None:
    assert render(build_vectors()).encode("utf-8") == VECTORS_PATH.read_bytes()


def test_main_writes_vector_file(tmp_path: Path) -> None:
    output = tmp_path / "test-vectors.json"
    main([str(output)])
    assert output.read_bytes() == render(build_vectors()).encode("utf-8")
