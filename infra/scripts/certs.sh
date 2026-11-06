#!/bin/bash
# The stack's internal certificate authority.
#
# Every link in the stack carries TLS, loopback or not, so each service needs a
# certificate and each client needs one thing to trust. This writes a CA and,
# for each NAME given, a certificate the CA signed, into DIR:
#
#   DIR/ca.key  DIR/ca.crt          the CA; clients trust ca.crt
#   DIR/NAME.key  DIR/NAME.crt      one per service, valid for NAME, localhost
#                                   and 127.0.0.1, which is how compose and
#                                   the host reach it
#
# Existing files are kept, so running it again is harmless. To rotate one
# certificate, delete its two files and run again; to rotate the CA, delete
# ca.key and ca.crt, which drops every certificate it signed as well.
#
# usage: certs.sh DIR NAME...
set -e

dir=$1
shift || true
if [ -z "$dir" ] || [ $# -eq 0 ]; then
    echo "usage: $0 DIR NAME..." >&2
    exit 2
fi
if ! command -v openssl >/dev/null 2>&1; then
    echo "✗ openssl is required to generate the stack's certificates" >&2
    exit 1
fi
mkdir -p "$dir"

curve="ec -pkeyopt ec_paramgen_curve:prime256v1"

if [ ! -s "$dir/ca.key" ] || [ ! -s "$dir/ca.crt" ]; then
    # A certificate signed by a CA that no longer exists is worthless.
    for crt in "$dir"/*.crt; do
        [ -e "$crt" ] || continue
        rm -f "$crt" "${crt%.crt}.key"
    done
    # shellcheck disable=SC2086
    if ! (umask 077; openssl req -x509 -newkey $curve -nodes \
        -keyout "$dir/ca.key" -out "$dir/ca.crt" -days 3650 \
        -subj "/CN=Freehold stack CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1); then
        echo "✗ Could not generate the CA (openssl 1.1.1 or later with -addext is needed)" >&2
        exit 1
    fi
    # The key stays owner-only; the certificate is what everyone trusts.
    chmod 644 "$dir/ca.crt"
    echo "✓ Generated the stack CA at $dir/ca.crt"
fi

for name in "$@"; do
    if [ -s "$dir/$name.key" ] && [ -s "$dir/$name.crt" ]; then
        continue
    fi
    # shellcheck disable=SC2086
    (umask 077; openssl req -new -newkey $curve -nodes \
        -keyout "$dir/$name.key" -out "$dir/$name.csr" -subj "/CN=$name" >/dev/null 2>&1)
    openssl x509 -req -in "$dir/$name.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" \
        -CAcreateserial -days 825 -out "$dir/$name.crt" \
        -extfile <(printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$name") \
        >/dev/null 2>&1
    rm -f "$dir/$name.csr"
    echo "✓ Generated $name's certificate at $dir/$name.crt"
done
