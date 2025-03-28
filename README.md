
# Nostr Signer for AWS Nitro Enclave

  

**Noauth-enclaved** is a [nip46](https://github.com/nostr-protocol/nips/blob/master/46.md) signer to be deployed inside [AWS Nitro Enclave](https://aws.amazon.com/ec2/nitro/nitro-enclaves/). Such deployement allows clients to cryptographically verify various claims about the code running on the server, and thus feel (more) confident that their keys won't be stolen.

  

From AWS:

> AWS Nitro Enclaves enables customers to create isolated compute environments to further protect and securely process highly sensitive data... Nitro Enclaves uses the same Nitro Hypervisor technology that provides CPU and memory isolation for EC2 instances... Nitro Enclaves includes cryptographic attestation for your software, so that you can be sure that only authorized code is running...

**The security of the AWS Nitro enclaves depends 100% on AWS - if you don't trust AWS then stop reading now and don't use this code.**

Read [this](https://blog.trailofbits.com/2024/02/16/a-few-notes-on-aws-nitro-enclaves-images-and-attestation/) for an independent analysis of the AWS Nitro enclaves' security.

## Why put Nostr keys on a server?
After more than 2 years in existence, there is still no reliable `nip46` signer. There is a tension between self-custody and reliability of the signer: you either keep the keys on your device (which is unreliable, especially on mobile), or you upload the keys to a signer server (which *usually* means you are 100% trusting the server to not steal your keys). To learn more about  the issue, read [here](https://hodlbod.npub.pro/post/1731367036685/). 

AWS Nitro enclaves promise to solve the problem of lack of trust for a particular service: anyone can verify the claims made by the service about the validity of the code that it's running (as long as one trusts AWS VM infrastructure). For a signer server in particular, this means there's much less chance for your keys to be stolen or hacked. Add to the mix a tie to `npub`s of people who built and launched the service, and you can use Nostr and WOT to discover and interact with provably safe services running inside AWS enclaves. The `noauth-enclaved` is the first prototype of such service.

## How it works?

An app holding your nsec may discover an instance of `noauth-enclaved`, may verify it's cryptographic [`attestation`](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html), and may upload your nsec to the instance. Once nsec is uploaded, the server starts processing `nip46` requests to your keys. Permissions of apps connected to your keys can be managed using [nsec.app](https://nsec.app) - they are saved on Nostr as encrypted events and are immediately discovered by the server.

The `attestation` announced by the `noauth-enclaved` as a Nostr event includes a verifiable info about the `hashes` of the server-side code, an npub of the `builder` - the person who built the AWS Nitro enclave image, and an npub of the `launcher` - the person who launched (and is running) the built image on AWS. The `service pubkey` that signs the `instance` Nostr event can be used to communicate with the service in an end-to-end-encrypted way over Nostr relays. A section below for *Launching the instance* can serve as a draft NIP for discovery and verification of services running in AWS Nitro enclaves. 

With the above data, clients can verify the validity of every `instance` event, can choose between builds (re-)produced by different people and instances launched by different people using WOT. Users can also reproduce a build of `noauth-enclaved` themselves to be sure which code is running in a specific instance. 

## Architecture

A process running inside the enclave has no access to persistent file storage, and no direct access to the network. The parent EC2 instance that launches the enclave does not have access to anything happening inside the enclave, and the only way for them to communicate is through a `VSOCK` interface.

The `noauth-enclaved` service consists of two processes - one called `enclave` (running inside the AWS Nitro enclave), and one called `parent` (running on the parent EC2 instance). The `enclave` uses [`socks`](https://en.wikipedia.org/wiki/SOCKS) protocol to forward all it's network requests (to Nostr relays) to the `parent` over `vsock`. The `parent` is running a `socks` proxy to forward the traffic from `vsock` to the target relays. This way `enclave` can receive and process `nip46` requests and can accept nsecs provided by clients.

The `enclave` code is reproducibly built into a docker image and then into AWS Nitro enclave image. The `parent` process runs a complementary service to supply the `enclave` process with build and instance metadata (`builder` and `launcher` info). The `builder` info is `kind:63795` event (`build signature`) generated during the enclave image build and tied to the resulting image. The `launcher` info is `kind:63796` event (`instance signature`) and is tied to the unique EC2 parent instance id. Both `build signature` and`instance signature` events are tied to the `attestation` produced by a running `enclave` process, discussed next.

When the `enclave` process is started, it fetches the `build signature` and `instance signature` events from the `parent`, fetches the `attestation` from the AWS VM that's running it and validates the events against the `attestation` to make sure parent isn't misbehaving. The `enclave` process then generates a `service pubkey` and publishes a `kind:63793` event (`instance event`) that includes the `attestation`, `build signature` and `instance signature`. The event is published onto `launcher` and `builder` outbox relays. A new `instance event` is published every `hour` to keep the `attestation` document fresh (it's signed by AWS and is valid for 3 hours).  

Clients discovering the `noauth-enclaved` instances using `instance events` can validate all the data included in the events - the `attestation`, `build signature` and `instance signature` are cryptographically tied together. If the `instance event` is valid, the client can be sure which specific version of the `enclaved` process is behind the `service pubkey`, which `builder` pubkey built the image, and which `launcher` pubkey is running it. 

If client and/or user decide to use a particular `noauth-enclaved` instance, the user's `nsec` can be imported into the instance by sending a `nip46-like` request to the `service pubkey` on a relay, announced in the `instance event`. After the `nsec` is imported, the instance starts processing `nip46` requests for it.  

## Building the docker image

A reproducible docker image for the `enclave` process is produced using [BuildKit](https://github.com/moby/buildkit) - it is used under the hood by the `docker buildx`, but docker doesn't expose the options necessary for reproducibility (`rewrite-timestamp=true`). Run:

```
./build-docker.sh
```

The command launches the BuiltKit's `buildctl` inside a docker container to produce a docker image in `./build/noauth-enclaved.tar`. The docker image metadata is saved to `./build/docker.json`, the hashes `containerimage.config.digest` and `containerimage.digest` must match for a reproduced image.

## Building the enclave image

After docker image is built we can build the enclave image - the `.eif` file. Installing the AWS Nitro build toolset (`nitro-cli`) isn't trivial, so it's best to perform the build on a nitro-capable EC2 instance. Suitable instance types are listed [here](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html#nitro-enclave-reqs), the build wasn't tested on ARM so don't choose ones with `g` suffix.

First, [install](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-cli-install.html) `nitro-cli` and `docker` on your EC2 instance. Then build the docker image as above. Next, run:
```
./build-enclave-signed.sh ${YOUR_NPUB}
```
This will generate an enclave image at `./build/noauth-enclaved.eif` and `./build/pcrs.json` file with `PCR` ([platform configuration registers](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html)) hashes. These hashes will be included by the enclave VM in an `attestation` document if this image is launched. Values `PCR0`, `PCR1` and `PCR2` must be reproducible from the same docker image.

To tie `${YOUR_NPUB}` to the produced `.eif` image, we will use `PCR8` register. The build script will generate a single-use `x509` key and will create an x509 certificate self-signed by that key at `./build/crt.pem`. The `certificate` will include `O=Nostr` and `OU=${YOUR_NPUB}`.

The build script will ask `nitro-cli` to sign the `.eif` with the x509 key and provide the `certificate`. The fingerprint hash of the `certificate` will be included as `PCR8` in `./build/pcrs.json` and will be reported in the `attestation`. The temporary x509 key is then deleted to avoid leaking it.

Next, a `build signature` event of `kind:63795` will be generated, including tags `["cert", <certificate_base64>]` and `["PCR8", <PCR8>]`. A nip46 connection to `${YOUR_NPUB}` will be established, the event signed and written to `./build/build.json`. This event will be supplied to the `enclave` process and included in the `instance event` along with the `attestation`, allowing clients to verify the `PCR8` against the `certificate` and your npub, ensuring that builder info can't be forged.

## Launching the instance

First, the `parent` process should be started:
```
./launch-parent.sh
```
It will start two `socat` processes forwarding `vsock` ports `1080` and `2080` to the same local `tcp` ports. It will also launch the `parent` process that serves `socks` proxy on `1080` port, and a WebSocket parent server on `2080`. 

Then you can launch the `enclave`:
```
./launch-enclave-signed.sh ${YOUR_NPUB}
``` 
This will first ask for your EC2 instance ID, convert it into `PCR4` register format, create nip46 connection to `${YOUR_NPUB}` (can differ from the builder npub) and produce an `instance signature` event of `kind:63796` with tag `["PCR4", <PCR4>]` in a file `./instance/instance.json`. It will also copy `./build/build.json` to `./instance/build.json`. These two files will be served by the `parent` process to the `enclave` when it's launched.

The `PCR4` value will be reported in an `attestation` from withing the enclave, and since EC2 instance IDs are unique to any launched instance and never reused, this value ties the `enclave` to `${YOUR_NPUB}` using `instance signature` event. 

Next, `nitro-cli` will be used to launch a Nitro enclave using the `./build/noauth-enclave.eif` image. The `enclave` process starts with `./enclave.sh`, which launches two `socat` processes to forward `tcp` ports 	`1080` and `2080` to the `vsock` interface, and launches the `enclave` process of the `noauth-enclaved`. 

The `enclave` process will generate a new Nostr key to serve as `service pubkey`. It will then get the `attestation` from the enclave VM, asking it to include the `service pubkey` into the `public_key` field of the `attestation` document. This way, the `attestation` ensures that the `service pubkey` can safely be used to talk to the `enclave` process. 

Next, `enclave` will make a WebSocket request to `2080` to their `parent`, supplying the `attestation`. The `parent` will verify the validity of the `attestation`'s `PCR8` value against `build signature` from `./instance/build.json` and validity of `PCR4` value against `./instance/instance.json`, and then forward these events to the `enclave`. 

The `enclave` will validate the received `build signature` and `instance signature` events against it's own `attestation`, and then publish the `instance` event of `kind:63793` with tags `["build", <build-signature-event>]`, `["instance", <instance-signature-event>]` and base64-encoded `attestation` as `content`. The `PCR` values will be included as `x` tags for discovery on relays. The `instance` event will be published onto the outbox relays of the `builder` and `launcher`.

Example `instance` event:
```
{
  "kind": 63793,
  "id": "df689a7344e4460d9a2490d3cb26920f5e69e773fb7de1bdbd2a09e9c853ae3f",
  "pubkey": "186aa45e63df8e4ff95cadd08f57b9b2f6715375c1ed30fc8eab15d75daf03f5",
  "created_at": 1742915128,
  "tags": [
    ["r", "https://github.com/nostrband/noauth-enclaved"],
    ["name", "noauth-enclaved"],
    ["v", "1.0.0"],
    ["m", "i-0ffff615a409a72d7-enc0195ccf9daaabc5b"],
    ["x",
      "bdc771e5c6483c54a0ff20c905d258bd230e1edae9dee3702ee9afeb95d9ce08e7174336ce4f5352222c154318c9e285",
      "PCR0"
    ],
    [
      "x",
      "4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493",
      "PCR1"
    ],
    [
      "x",
      "443786ebb848bcd2162d99adfd76ed10f772ddbc19f2f5e01122f90389724762e0341844534a403af11b793fb61ee188",
      "PCR2"
    ],
    [
      "x",
      "6386cee86c94b2a713c98e1d883134e8f2c019a17a712eb950fde15e9d6667575569c4e5c5e66eb9c920369961025fd2",
      "PCR4"
    ],
    [
      "x",
      "35235575680337d50f604d08eeb7cb220729e4d0f6b0d05476baafb052a7c2413f78058fefface5e1477046534d4fdb2",
      "PCR8"
    ],
    [
      "build",
      "{\"id\":\"16b94c206beceb8295d08d3a7f1d4b68699c181ca539a801f4e485fe8bb81f9a\",\"created_at\":1742900630,\"pubkey\":\"3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd\",\"kind\":63795,\"tags\":[[\"-\"],[\"expiration\",\"1742899630\"],[\"cert\",\"MIICZzCCAewCFGYXOCkfEYtU1xaoCAozKgyfGez4MAoGCCqGSM49BAMDMIGWMQ4wDAYDVQQDDAVOb3N0cjELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAldBMRAwDgYDVQQHDAdTZWF0dGxlMQ4wDAYDVQQKDAVOb3N0cjFIMEYGA1UECww/bnB1YjF4ZHRkdWNkbmplcmV4ODhna2cycWsyYXRzZGxxc3l4cWFhZzRoMDVqbWNweXNwcXQzMHdzY21udHh5MB4XDTI1MDMyNTExMDM0NFoXDTMwMDkxNTExMDM0NFowgZYxDjAMBgNVBAMMBU5vc3RyMQswCQYDVQQGEwJVUzELMAkGA1UECAwCV0ExEDAOBgNVBAcMB1NlYXR0bGUxDjAMBgNVBAoMBU5vc3RyMUgwRgYDVQQLDD9ucHViMXhkdGR1Y2RuamVyZXg4OGdrZzJxazJhdHNkbHFzeXhxYWFnNGgwNWptY3B5c3BxdDMwd3NjbW50eHkwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAR25TXC8DVH6HKEMl8ZAUc/C0SysE02VJpYO2gqacQnHC8/HOv1U2FoYY1+agOj8NWmI+znCbB4ViW08H31hL45bshDzEUO39taPCYCMPmnLOt/tm36rlcrcUfw/Zfkce4wCgYIKoZIzj0EAwMDaQAwZgIxAPSqsAXLHHXJC6AFcOjtTYavJsWrGRwrBNcIEhEI0z7tZr5gJ5I99cH9BqSXTl7xMQIxANsErVz/lqiY+qwaWe+p4+kyJ6DBc/AwHvTnQ15vJxRJW4GP7oEkbG0nquyKEFyzgA==\"],[\"PCR8\",\"35235575680337d50f604d08eeb7cb220729e4d0f6b0d05476baafb052a7c2413f78058fefface5e1477046534d4fdb2\"]],\"content\":\"\",\"sig\":\"5bc824bedf2f7c0a24d8cdb60a4a7dcbc5457e6a5091dfdeedb3c6adfba666823729ead09e9a90d1fad8a1d45e7dbb77bf5951cb26df947d6ea534ad85095e5f\"}"
    ],
    [
      "instance",
      "{\"id\":\"d27bfa50b0705b5a1b48171bb0e3edc9d12b2b83208f485830d9e91446e91d84\",\"created_at\":1742894977,\"pubkey\":\"3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd\",\"kind\":63795,\"tags\":[[\"-\"],[\"expiration\",\"1742893977\"],[\"PCR4\",\"6386cee86c94b2a713c98e1d883134e8f2c019a17a712eb950fde15e9d6667575569c4e5c5e66eb9c920369961025fd2\"]],\"content\":\"\",\"sig\":\"9af5e8058858733caa617b8b907c53550a9c090261b1ead57022e4e4f7d1c3bc9b7051002c2d0097a8a3cd9596763914a782aacc27c9592462071f811ecb3e4b\"}"
    ],
    ["relay", "wss://relay.nsec.app"],
    ["expiration", "1742925928"],
    ["alt", "noauth-enclaved instance"]
  ],
  "content": "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",
  "sig": "4c24f9cad8b4bf302f0f4cd56cf112a5a6183bc9f9ed73f959f882e5f8f3c04f824d10fc5c59faaf07c5a41fa4016baa5fde52fe62f8f01b1517a149901496fe"
}
``` 

Matching `build signature` example (from `build` tag):
```
{
  "id": "16b94c206beceb8295d08d3a7f1d4b68699c181ca539a801f4e485fe8bb81f9a",
  "created_at": 1742900630,
  "pubkey": "3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd",
  "kind": 63795,
  "tags": [
    [
      "-"
    ],
    [
      "expiration",
      "1742899630"
    ],
    [
      "cert",
      "MIICZzCCAewCFGYXOCkfEYtU1xaoCAozKgyfGez4MAoGCCqGSM49BAMDMIGWMQ4wDAYDVQQDDAVOb3N0cjELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAldBMRAwDgYDVQQHDAdTZWF0dGxlMQ4wDAYDVQQKDAVOb3N0cjFIMEYGA1UECww/bnB1YjF4ZHRkdWNkbmplcmV4ODhna2cycWsyYXRzZGxxc3l4cWFhZzRoMDVqbWNweXNwcXQzMHdzY21udHh5MB4XDTI1MDMyNTExMDM0NFoXDTMwMDkxNTExMDM0NFowgZYxDjAMBgNVBAMMBU5vc3RyMQswCQYDVQQGEwJVUzELMAkGA1UECAwCV0ExEDAOBgNVBAcMB1NlYXR0bGUxDjAMBgNVBAoMBU5vc3RyMUgwRgYDVQQLDD9ucHViMXhkdGR1Y2RuamVyZXg4OGdrZzJxazJhdHNkbHFzeXhxYWFnNGgwNWptY3B5c3BxdDMwd3NjbW50eHkwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAR25TXC8DVH6HKEMl8ZAUc/C0SysE02VJpYO2gqacQnHC8/HOv1U2FoYY1+agOj8NWmI+znCbB4ViW08H31hL45bshDzEUO39taPCYCMPmnLOt/tm36rlcrcUfw/Zfkce4wCgYIKoZIzj0EAwMDaQAwZgIxAPSqsAXLHHXJC6AFcOjtTYavJsWrGRwrBNcIEhEI0z7tZr5gJ5I99cH9BqSXTl7xMQIxANsErVz/lqiY+qwaWe+p4+kyJ6DBc/AwHvTnQ15vJxRJW4GP7oEkbG0nquyKEFyzgA=="
    ],
    [
      "PCR8",
      "35235575680337d50f604d08eeb7cb220729e4d0f6b0d05476baafb052a7c2413f78058fefface5e1477046534d4fdb2"
    ]
  ],
  "content": "",
  "sig": "5bc824bedf2f7c0a24d8cdb60a4a7dcbc5457e6a5091dfdeedb3c6adfba666823729ead09e9a90d1fad8a1d45e7dbb77bf5951cb26df947d6ea534ad85095e5f"
}
```

Matching `instance signature` example (from `instance` tag):
```
{
  "id": "d27bfa50b0705b5a1b48171bb0e3edc9d12b2b83208f485830d9e91446e91d84",
  "created_at": 1742894977,
  "pubkey": "3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd",
  "kind": 63795,
  "tags": [
    [
      "-"
    ],
    [
      "expiration",
      "1742893977"
    ],
    [
      "PCR4",
      "6386cee86c94b2a713c98e1d883134e8f2c019a17a712eb950fde15e9d6667575569c4e5c5e66eb9c920369961025fd2"
    ]
  ],
  "content": "",
  "sig": "9af5e8058858733caa617b8b907c53550a9c090261b1ead57022e4e4f7d1c3bc9b7051002c2d0097a8a3cd9596763914a782aacc27c9592462071f811ecb3e4b"
}
```

Anyone who discovers the `instance` event can validate the supplied `attestation` in the `content` against `build` and `instance` tags and decide if they are willing to trust the instance. FIXME link to verification code. They could then communicate to the `service pubkey` using a relay specified in the `relay` tag.

FIXME prod/dev build signature tags?

## Importing the nsec

**DANGER: do not use your real nsec! This is experimental tech!**

First, find an instance `service pubkey`:

```
SERVICE_PUBKEY=`echo '{"kinds":[63793], "limit": 1}' | nak req wss://relay.primal.net | jq .pubkey`
```

The `wss://relay.primal.net` is an outbox relay of the launcher of the dev instance.

Then import your nsec:
```
echo ${NSEC} | tsx src/index.ts cli import_key wss://relay.nsec.app ${SERVICE_PUBKEY}
```

The `wss://relay.nsec.app` is announced in the `kind:63793` event above.

Note that the `enclave` does not process nip46 `connect` requests - you need to import the `nsec` into `nsec.app` first, then establish a connection to some client, then log-out in `nsec.app` and import the key into the enclave. After that, nip46 requests sent by the client will be served by the enclave.

Another method to import a key without depending on `nsec.app` is `connect_key` - it imports your nsec and connects it to a `client pubkey` you provide and gives full permissions to it:
```
echo ${NSEC} | tsx src/index.ts cli connect_key wss://relay.nsec.app ${SERVICE_PUBKEY} ${CLIENT_PUBKEY}
```

To delete your key call `delete_key`:
```
echo ${NSEC} | tsx src/index.ts cli delete_key wss://relay.nsec.app ${SERVICE_PUBKEY}
```


To generate a test key with a reusable `bunker url` and full permissions, valid for 1 day:
```
tsx src/index.ts cli generate_test_key wss://relay.nsec.app ${SERVICE_PUBKEY} # returns a bunker url
```
