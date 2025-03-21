#!/bin/sh

export ENCLAVED="true"
# no ip address is assigned to lo interface by default
ifconfig lo 127.0.0.1
# 3 = CID of parent
socat TCP4-LISTEN:1080,reuseaddr,fork VSOCK-CONNECT:3:1080 &
# launch
cd /usr/src/app; node_modules/.bin/tsx src/index.ts enclave run socks://127.0.0.1:1080 wss://relay.nsec.app #> log.txt 2>&1 &


