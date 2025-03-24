#!/bin/sh

# signal that we can access the NSM
#export ENCLAVED="true"
# no ip address is assigned to lo interface by default
ifconfig lo 127.0.0.1
# 3 = CID of parent
socat TCP4-LISTEN:1080,reuseaddr,fork VSOCK-CONNECT:3:1080 &
# launch, is the process exits the enclave terminates too
cd /usr/src/app; node_modules/.bin/tsx src/enclave/run.ts socks://127.0.0.1:1080 wss://relay.nsec.app


