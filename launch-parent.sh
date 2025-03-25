SOCKS=1080
PARENT=2080
sudo socat VSOCK-LISTEN:${SOCKS},reuseaddr,fork TCP:localhost:${SOCKS} &
sudo socat VSOCK-LISTEN:${PARENT},reuseaddr,fork TCP:localhost:${PARENT} &
tsx src/index.ts parent run 1080 2080 >parent.log 2>&1 &
echo "Launched"