#!/bin/sh

SOCKS=1080
PARENT=2080

# no ip address is assigned to lo interface by default
ifconfig lo 127.0.0.1
# 3 = CID of parent
socat TCP4-LISTEN:${SOCKS},reuseaddr,fork VSOCK-CONNECT:3:${SOCKS} &
socat TCP4-LISTEN:${PARENT},reuseaddr,fork VSOCK-CONNECT:3:${PARENT} &
# launch, if the process exits the enclave terminates too
cd /usr/src/app; node_modules/.bin/tsx src/enclave/run.ts 


