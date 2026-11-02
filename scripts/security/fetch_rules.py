"""Fetch immutable upstream rules for internal CI use; never vendor their text."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
from urllib.request import urlopen


def unpack_verified(data, manifest, destination):
    if not re.fullmatch(r'[0-9a-f]{40}', manifest['upstreamCommit']):
        raise ValueError('Invalid upstream commit')
    if hashlib.sha256(data).hexdigest() != manifest['archiveSha256']:
        raise ValueError('Upstream archive checksum mismatch')
    paths = manifest['paths']
    if not isinstance(paths, list) or not paths:
        raise ValueError('No rules selected')
    for path in paths:
        p = PurePosixPath(path)
        if p.is_absolute() or '..' in p.parts or '\\' in path or p.suffix not in ('.yaml', '.yml'):
            raise ValueError('Unsafe rule path')
    prefix = 'semgrep-rules-' + manifest['upstreamCommit'] + '/'
    # Validate every member before writing anything. Never extract symlinks,
    # arbitrary upstream files or tar paths into the repository.
    files = []
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for path in [*paths, 'LICENSE']:
            member = archive.getmember(prefix + path)
            if not member.isfile() or member.size > 1_000_000:
                raise ValueError('Invalid rule member')
            files.append((path, archive.extractfile(member).read()))
    for path, content in files:
        output = destination / path
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)


def main():
    if len(sys.argv) != 3:
        raise ValueError('Usage: fetch_rules.py manifest.json output-directory')
    manifest = json.loads(Path(sys.argv[1]).read_text())
    if not re.fullmatch(r'[0-9a-f]{40}', manifest['upstreamCommit']):
        raise ValueError('Invalid upstream commit')
    url = 'https://codeload.github.com/semgrep/semgrep-rules/tar.gz/' + manifest['upstreamCommit']
    with urlopen(url, timeout=90) as response:
        data = response.read(32_000_001)
    if len(data) > 32_000_000:
        raise ValueError('Upstream archive exceeded size limit')
    unpack_verified(data, manifest, Path(sys.argv[2]))
    print('Verified upstream rule archive and selected', len(manifest['paths']), 'files')


if __name__ == '__main__':
    main()
