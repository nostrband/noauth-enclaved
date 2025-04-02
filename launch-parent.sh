SOCKS=1080
PARENT=2080
sudo killall socat
killall node
sleep 2
sudo socat VSOCK-LISTEN:${SOCKS},reuseaddr,fork,forever,keepalive TCP:localhost:${SOCKS} &
sudo socat VSOCK-LISTEN:${PARENT},reuseaddr,fork,forever,keepalive TCP:localhost:${PARENT} &
tsx src/index.ts parent run 1080 2080 >parent.log 2>&1 &
echo "Launched"