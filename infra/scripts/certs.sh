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
# The CA is constrained to those names, localhost and 127.0.0.1 (a critical
# nameConstraints extension), so a browser or host that trusts it trusts it
# for the stack alone: even with ca.key in hand nobody can sign for a public
# site. A name the CA was not created with needs a new CA.
#
# A certificate that exists and verifies against the CA is kept, so running
# it again is harmless; one the CA did not sign is re-issued. To rotate one
# certificate, delete its two files and run again; to rotate the CA, or to
# add a name, delete ca.key and ca.crt and run again with every name, and
# every certificate is re-issued under the new CA. Nothing else in DIR is
# touched.
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
    permitted="permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255"
    for name in "$@"; do
        permitted="$permitted,permitted;DNS:$name"
    done
    # shellcheck disable=SC2086
    if ! (umask 077; openssl req -x509 -newkey $curve -nodes \
        -keyout "$dir/ca.key" -out "$dir/ca.crt" -days 3650 \
        -subj "/CN=Freehold stack CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -addext "nameConstraints=critical,$permitted" >/dev/null 2>&1); then
        echo "✗ Could not generate the CA (openssl 1.1.1 or later with -addext is needed)" >&2
        exit 1
    fi
    # The key stays owner-only; the certificate is what everyone trusts.
    chmod 644 "$dir/ca.crt"
    echo "✓ Generated the stack CA at $dir/ca.crt (for: localhost, 127.0.0.1, $*)"
fi

for name in "$@"; do
    # Kept only while the CA vouches for it; a leaf from a rotated CA is re-issued.
    if [ -s "$dir/$name.key" ] && [ -s "$dir/$name.crt" ] \
        && openssl verify -CAfile "$dir/ca.crt" "$dir/$name.crt" >/dev/null 2>&1; then
        continue
    fi
    # shellcheck disable=SC2086
    (umask 077; openssl req -new -newkey $curve -nodes \
        -keyout "$dir/$name.key" -out "$dir/$name.csr" -subj "/CN=$name" >/dev/null 2>&1)
    if ! signing=$(openssl x509 -req -in "$dir/$name.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" \
        -CAcreateserial -days 825 -out "$dir/$name.crt" \
        -extfile <(printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$name") \
        2>&1 >/dev/null); then
        rm -f "$dir/$name.csr" "$dir/$name.key" "$dir/$name.crt"
        echo "✗ Could not sign $name's certificate with $dir/ca.key:" >&2
        echo "$signing" >&2
        exit 1
    fi
    rm -f "$dir/$name.csr"
    if ! openssl verify -CAfile "$dir/ca.crt" "$dir/$name.crt" >/dev/null 2>&1; then
        rm -f "$dir/$name.key" "$dir/$name.crt"
        echo "✗ The CA is constrained to the names it was created with, and $name is not one:" >&2
        echo "  delete $dir/ca.key and $dir/ca.crt and run again with every name" >&2
        exit 1
    fi
    echo "✓ Generated $name's certificate at $dir/$name.crt"
done
