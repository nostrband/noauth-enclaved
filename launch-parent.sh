sudo socat VSOCK-LISTEN:1080,reuseaddr,fork TCP:localhost:1080 &
tsx src/index.ts parent run 1080 >parent.log 2>&1 &
echo "Launched"