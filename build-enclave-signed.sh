#!/bin/bash

# exit on failure
set -e

# name of the image files
FILE=noauth-enclaved
# target dir
BUILD=./build/

# builder
NPUB=$1

# used for nitro-cli describe-eif,
# not included in attestation doc
NAME=`cat package.json | jq .name`
VER=`cat package.json | jq .version`

# x509 stuff for PCR8
KEY=esk.pem
CSR=csr.pem
CRT=crt.pem

# ensure
mkdir -p ${BUILD}

# save for publish_build and other utils later
echo ${NPUB} > ${BUILD}/npub.txt

# import the image created by buildkit into docker
# so that nitro-cli could use it to build eif
docker load -i ${BUILD}${FILE}.tar

# to produce PCR8 linking the build to NPUB
openssl ecparam -name secp384r1 -genkey -out ${BUILD}${KEY}
openssl req -new -key ${BUILD}${KEY} -sha384 -nodes -subj "/CN=Nostr/C=US/ST=WA/L=Seattle/O=Nostr/OU=${NPUB}" -out ${BUILD}${CSR}
openssl x509 -req -days 2000 -in ${BUILD}${CSR} -out ${BUILD}${CRT} -sha384 -signkey ${BUILD}${KEY}
rm ${BUILD}${CSR} # no longer needed

# build PCRS destination
PCRS=pcrs.json

# build eif from docker tar
nitro-cli build-enclave --docker-uri ${FILE}:latest --output-file ${BUILD}${FILE}.eif --private-key ${BUILD}${KEY} --signing-certificate ${BUILD}${CRT} --name ${NAME} --version ${VER} > ${BUILD}${PCRS}

# drop the key to make sure it can't be stolen,
# otherwise someone else could launch an instance 
# that would report itself as $NPUB's 
rm ${BUILD}${KEY}

# create a file to be served by parent process to the
# enclave so that enclave could report the $NPUB as builder
# of this instance
tsx src/index.ts cli sign_build ${BUILD}
