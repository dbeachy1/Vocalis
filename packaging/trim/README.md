# Trim inference inputs

`panns-artifacts.lock.json` freezes the publisher wheel and complete source
distribution for PANNs 0.1.1. Both artifacts matched PyPI's published sizes and
SHA256 values; the unmodified MIT notice is retained here. The source and wheel
are not stored in Git; they are downloaded from the locked addresses.

`requirements.cpu.in` and `requirements.cpu.lock` freeze the CPython 3.12 Linux
x86_64 CPU inference environment. The lock is the byte-verified 50-wheel set
totaling 516,894,296 bytes. Its hashes were checked against the wheelhouse
manifest. The supported image build is
`Dockerfile`; its `Dockerfile.dockerignore` limits the repository-root context
to the locked wheelhouse, scorer, and required notices. Supply a verified
clean CUDA or ROCm application base by `BASE_IMAGE` and its exact image ID by
`BASE_IMAGE_ID`; the build runs offline and keeps the CPU venv separate from
the application environment.

For example, after confirming the parent tag resolves to the ID you expect:

```sh
docker image inspect <base image> --format '{{.Id}} {{.Created}}'
docker buildx build --builder default --network=none --load \
  --build-arg BASE_IMAGE=<base image> \
  --build-arg BASE_IMAGE_ID=<the base image's full ID> \
  --build-arg LOCK_SHA256=f14fd7063a67d26ad763c4145e0dc30dfeeeac7e30e91c11d832051800e4b7fe \
  --build-arg PANN_PATCH_SHA256=71b579eefc3afd255ca0484c036e300430f62a3f87130a632020fc380168e60c \
  --build-arg APPLY_HELPER_SHA256=974700bf3d4d8697cf4251b80c11c249e30c69c5b0737ead8d93d8de78633df7 \
  --build-arg SCORER_SHA256=c14af002a2bb1c2f309bfc76070f480e9797f0bc1f16dc46270d71abf6bbb295 \
  --file packaging/trim/Dockerfile \
  --tag vocalis-trim-cpu-candidate .
```

Use the actual inspected base ID and corresponding verified build arguments when
building on another accepted base; do not rely on a mutable tag alone.

The explicit local-input overlay replaces reachable automatic downloads with
useful missing-input errors. It scopes an allowlist of the checkpoint's inspected
NumPy metadata globals around only PANNs' CNN14 load and keeps PyTorch's
`weights_only=True` restricted unpickler. The exact upstream and patched source
hashes are recorded in the lock. The frozen CNN14 checkpoint and Google AudioSet class
index have separate provenance, attribution, and grants under
`packaging/models/trim/`. Runtime input validation does not rehash the large model
on each request. The source overlay is applied only after the pinned wheel is
installed. It removes the two affected CPython 3.12 bytecode files afterward so
Python cannot run pre-overlay cached code when source timestamp and size metadata
match. The final image declares Numba and Matplotlib caches under the existing
writable `/cache/vocalis` mount; it does not redirect HOME or add a mount.
