#!/bin/bash

FILE=noauth-enclaved
BUILD=./build/

docker load -i ${BUILD}${FILE}.tar

NPUB=$1

# save for publish_build
echo ${NPUB} > ${BUILD}/npub.txt

# used for nitro-cli describe-eif,
# not included in attestation doc
NAME=`cat package.json | jq .name`
VER=`cat package.json | jq .version`

# to produce PCR8 linking the build to NPUB
KEY=esk.pem
CSR=csr.pem
CRT=crt.pem
openssl ecparam -name secp384r1 -genkey -out ${BUILD}${KEY}
openssl req -new -key ${BUILD}${KEY} -sha384 -nodes -subj "/CN=Nostr/C=US/ST=WA/L=Seattle/O=Nostr/OU=${NPUB}" -out ${BUILD}${CSR}
openssl x509 -req -days 2000 -in ${BUILD}${CSR} -out ${BUILD}${CRT} -sha384 -signkey ${BUILD}${KEY}

# build PCRS destination
PCRS=pcrs.json

# build eif from docker tar
nitro-cli build-enclave --docker-uri ${FILE}:latest --output-file ${BUILD}${FILE}.eif --private-key ${BUILD}${KEY} --signing-certificate ${BUILD}${CRT} --name ${NAME} --version ${VER} > ${BUILD}${PCRS}

