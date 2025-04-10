
# Nostr Signer for AWS Nitro Enclave

**Noauth-enclaved** is a [nip46](https://github.com/nostr-protocol/nips/blob/master/46.md) signer to be deployed inside [AWS Nitro Enclave](https://aws.amazon.com/ec2/nitro/nitro-enclaves/). Such deployement allows clients to cryptographically verify various claims about the code running on the server, and thus feel (more) confident that their keys won't be stolen.

From AWS:

> AWS Nitro Enclaves enables customers to create **isolated compute environments** to further protect and securely process highly sensitive data... Nitro Enclaves uses the same Nitro Hypervisor technology that provides **CPU and memory isolation** for EC2 instances... Nitro Enclaves includes **cryptographic attestation for your software**, so that you can be sure that only authorized code is running...

**The security of the AWS Nitro enclaves depends 100% on AWS - if you don't trust AWS then stop reading now and don't use this code.**

Read [this](https://blog.trailofbits.com/2024/02/16/a-few-notes-on-aws-nitro-enclaves-images-and-attestation/) and [this](https://blog.trailofbits.com/2024/09/24/notes-on-aws-nitro-enclaves-attack-surface/) for an independent analysis of the AWS Nitro enclaves' security.

## Why put Nostr keys on a server?
After more than 2 years in existence, there is still no reliable `nip46` signer. There is a tension between self-custody and reliability of the signer: you either keep the keys on your device (which is unreliable, especially on mobile), or you upload the keys to a signer server (which *usually* means you are 100% trusting the server to not steal your keys). To learn more about  the issue, read [here](https://hodlbod.npub.pro/post/1731367036685/). 

AWS Nitro enclaves promise to solve the problem of lack of trust for a particular service. The code running inside an enclave is fully isolated by AWS from the person launching it. The attestation signed by AWS and reproducible open-source code let anyone verify what exactly is happening inside the enclave (as long as one trusts AWS VM infrastructure). For a signer server in particular, this means there's much less chance for your keys to be stolen or hacked. Add to the mix a tie to `npub`s of people who built and launched the service, and you can use Nostr and WoT to discover and interact with provably safe services running inside AWS enclaves. The `noauth-enclaved` is the first prototype of such service.

## How it works?

An app holding your nsec may discover an instance of `noauth-enclaved`, may verify it's cryptographic [`attestation`](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html), and may upload your nsec to the instance. Once nsec is uploaded, the server starts processing `nip46` requests to your keys. Permissions of apps connected to your keys can be managed using [nsec.app](https://nsec.app) - they are saved on Nostr as encrypted events and are immediately discovered by the server. There is also an API (below) for more direct control over the keys.

The `attestation` announced by the `noauth-enclaved` as a Nostr event includes a verifiable info about the `hashes` of the server-side code, an npub of the `builder` - the person who built the AWS Nitro enclave image, and an npub of the `launcher` - the person who launched (and is running) the built image on AWS. The `service pubkey` that signs the `instance` Nostr event can be used to communicate with the service in an end-to-end-encrypted way over Nostr relays. A section below for *Launching the instance* can serve as a draft NIP for discovery and verification of services running in AWS Nitro enclaves. 

With the above data, clients can verify the validity of every `instance` event, can choose between builds (re-)produced by different people and instances launched by different people using WOT. Users can also reproduce a build of `noauth-enclaved` themselves to be sure which code is running in a specific instance. 

## Properties

The `noauth-enclaved` service running inside Nitro Enclave provides:
- **attestation** - a document signed by AWS that specifies hashes of the code image running on the server
- **isolation** - AWS virtualization layer ensures that whoever launched the enclave *does not have access* to whatever is happening in the enclave
- **reproducibility** - the code of `noauth-enclaved` is open source and reproducibly built into an enclave image, allowing anyone to review it, rebuild it, and compare image hashes to ones published by any running instance
- **attribution** - each image has a cryptographic link to `builder` npub that created the image, and `launcher` npub that is running it, allowing clients to apply WoT filters and other Nostr-enabled interactions
- **reliability** - the end goal of deploying a signer on a server is achieved without a typical sacrifice of fully trusting a custodial black-box service

## Architecture

A process running inside the enclave has no access to persistent file storage, and no direct access to the network. The parent EC2 instance that launches the enclave does not have access to anything happening inside the enclave, and the only way for them to communicate is through a `VSOCK` interface.

The `noauth-enclaved` service consists of two processes - one called `enclave` (running inside the AWS Nitro enclave), and one called `parent` (running on the parent EC2 instance). The `enclave` uses [`socks`](https://en.wikipedia.org/wiki/SOCKS) protocol to forward all it's network requests (to Nostr relays) to the `parent` over `vsock`. The `parent` is running a `socks` proxy to forward the traffic from `vsock` to the target relays. This way `enclave` can receive and process `nip46` requests and can accept nsecs provided by clients.

The `enclave` code is reproducibly built into a docker image and then into AWS Nitro enclave image. The `parent` process runs a complementary service to supply the `enclave` process with build and instance metadata (`builder` and `launcher` info). The `builder` info is `kind:63795` event (`build signature`) generated during the enclave image build and tied to the resulting image. The `launcher` info is `kind:63796` event (`instance signature`) and is tied to the unique EC2 parent instance id. Both `build signature` and`instance signature` events are tied to the `attestation` produced by a running `enclave` process, discussed next.

When the `enclave` process is started, it fetches the `build signature` and `instance signature` events from the `parent`, fetches the `attestation` from the AWS VM that's running it and validates the events against the `attestation` to make sure parent isn't misbehaving. The `enclave` process then generates a `service pubkey` and publishes a `kind:63793` event (`instance event`) that includes the `attestation`, `build signature` and `instance signature`. The event is published onto `launcher` and `builder` outbox relays. A new `instance event` is published every `hour` to keep the `attestation` document fresh (it's signed by AWS and is valid for 3 hours).  

Clients discovering the `noauth-enclaved` instances using `instance events` can validate all the data included in the events - the `attestation`, `build signature` and `instance signature` are cryptographically tied together. If the `instance event` is valid, the client can be sure which specific version of the `enclaved` process is behind the `service pubkey`, which `builder` pubkey built the image, and which `launcher` pubkey is running it. Expected hashes are located in `pcrs.json` and `docker.json` files committed to this repo (updated whenever changes are made to the code).

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
  "id": "dcd7769314c4a0dac97afb05ab68cebb94fcd120f4d34355f5e0788b3acd9757",
  "pubkey": "ac116b22152178636e06d75188c260da10ecd54765d3999bcb579c8f530a9441",
  "created_at": 1743516970,
  "tags": [
    [
      "r",
      "https://github.com/nostrband/noauth-enclaved"
    ],
    [
      "name",
      "noauth-enclaved"
    ],
    [
      "v",
      "1.0.0"
    ],
    [
      "m",
      "i-0ffff615a409a72d7-enc0195f17eaba9b385"
    ],
    [
      "x",
      "517a9ec66c4c8e8f3b309c4a4598e2383dff4ec07dfa48617c2d7ec9b1fbf86a597b4376b18114914a31af2ea12a2db6",
      "PCR0"
    ],
    [
      "x",
      "4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493",
      "PCR1"
    ],
    [
      "x",
      "365caf856d5ef95d4ef49b1883367179fd5d40504d75d8b0c8af7672aff3bb37c0026a69c89d170bdc724b53e8423a7d",
      "PCR2"
    ],
    [
      "x",
      "6386cee86c94b2a713c98e1d883134e8f2c019a17a712eb950fde15e9d6667575569c4e5c5e66eb9c920369961025fd2",
      "PCR4"
    ],
    [
      "x",
      "7e3f4c20f65f0a62de884a41ef73fd693c136173fec4ad19336d2ce3b1d63246da3383cbb83cd10dad77d5d1aafcdce1",
      "PCR8"
    ],
    [
      "t",
      "dev"
    ],
    [
      "relay",
      "wss://relay.nsec.app"
    ],
    [
      "expiration",
      "1743527770"
    ],
    [
      "alt",
      "noauth-enclaved instance"
    ],
    [
      "build",
      "{\"id\":\"09826e152bcddce14a72179dc9fc648f8781cc5019de0b03dd83a059b90579ce\",\"created_at\":1743513252,\"pubkey\":\"3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd\",\"kind\":63795,\"tags\":[[\"-\"],[\"t\",\"dev\"],[\"cert\",\"MIICZjCCAewCFHrSncuGEPMYTOF8uzoyP8fUj8C3MAoGCCqGSM49BAMDMIGWMQ4wDAYDVQQDDAVOb3N0cjELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAldBMRAwDgYDVQQHDAdTZWF0dGxlMQ4wDAYDVQQKDAVOb3N0cjFIMEYGA1UECww/bnB1YjF4ZHRkdWNkbmplcmV4ODhna2cycWsyYXRzZGxxc3l4cWFhZzRoMDVqbWNweXNwcXQzMHdzY21udHh5MB4XDTI1MDQwMTEzMTQwNVoXDTMwMDkyMjEzMTQwNVowgZYxDjAMBgNVBAMMBU5vc3RyMQswCQYDVQQGEwJVUzELMAkGA1UECAwCV0ExEDAOBgNVBAcMB1NlYXR0bGUxDjAMBgNVBAoMBU5vc3RyMUgwRgYDVQQLDD9ucHViMXhkdGR1Y2RuamVyZXg4OGdrZzJxazJhdHNkbHFzeXhxYWFnNGgwNWptY3B5c3BxdDMwd3NjbW50eHkwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAATk4LYEsRVWZWQvqYeyREoIaf10MMs7QSYNZC5Lpi7fTJnn/p+A20WWbgWJhsUe5BXjbvw3SU9ZCZpGt5QhY3VJV9LiHbQs9cDk7LW0S3sl0rN/9X5RRLh96hvJzg9cR90wCgYIKoZIzj0EAwMDaAAwZQIxAJ1F+wpyeV0OKb94PRvVWELfhuiZ6w40xDahGuGmcFTkXe0YPviTo0uhB07XsibGVAIwdf5SZEn181+99J3GQoAWkimMy41c51IaezIY8hpstky8SDhRhOpdvgw2cyst7ciq\"],[\"PCR8\",\"7e3f4c20f65f0a62de884a41ef73fd693c136173fec4ad19336d2ce3b1d63246da3383cbb83cd10dad77d5d1aafcdce1\"]],\"content\":\"\",\"sig\":\"17f87814835b14c3028789bfc76725a095bcceea59886dfce4dda487bb17eb76858794cdd354ae1f64be39c72ecb7c149e5093e94e7176425aa1214a556389af\"}"
    ],
    [
      "p",
      "3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd",
      "builder"
    ],
    [
      "instance",
      "{\"id\":\"ba52dbd7d4943068d10030f14b74dc3511698ecf53dff1190c446ffc0749d646\",\"created_at\":1743491523,\"pubkey\":\"3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd\",\"kind\":63796,\"tags\":[[\"-\"],[\"t\",\"dev\"],[\"PCR4\",\"6386cee86c94b2a713c98e1d883134e8f2c019a17a712eb950fde15e9d6667575569c4e5c5e66eb9c920369961025fd2\"]],\"content\":\"\",\"sig\":\"bd9c2278beb7cd0023e3e8cb8794e1d29ac76e28182cb54240c8f56752f92019233463a643c606362dc996d303db532df88633e1a53532ee0f23d724df89e1dd\"}"
    ],
    [
      "p",
      "3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd",
      "launcher"
    ]
  ],
  "content": "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",
  "sig": "391a1beafa5432c78cb176b1e1e899a1c61e80fbf97ccec94a6575d657452c10214494a0504cc81568baf7ebd1c63790c77265bcca7184ed159d676259c5c78a"
}
``` 

Matching `build signature` example (from `build` tag):
```
{
  "id": "09826e152bcddce14a72179dc9fc648f8781cc5019de0b03dd83a059b90579ce",
  "created_at": 1743513252,
  "pubkey": "3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd",
  "kind": 63795,
  "tags": [
    [
      "-"
    ],
    [
      "t",
      "dev"
    ],
    [
      "cert",
      "MIICZjCCAewCFHrSncuGEPMYTOF8uzoyP8fUj8C3MAoGCCqGSM49BAMDMIGWMQ4wDAYDVQQDDAVOb3N0cjELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAldBMRAwDgYDVQQHDAdTZWF0dGxlMQ4wDAYDVQQKDAVOb3N0cjFIMEYGA1UECww/bnB1YjF4ZHRkdWNkbmplcmV4ODhna2cycWsyYXRzZGxxc3l4cWFhZzRoMDVqbWNweXNwcXQzMHdzY21udHh5MB4XDTI1MDQwMTEzMTQwNVoXDTMwMDkyMjEzMTQwNVowgZYxDjAMBgNVBAMMBU5vc3RyMQswCQYDVQQGEwJVUzELMAkGA1UECAwCV0ExEDAOBgNVBAcMB1NlYXR0bGUxDjAMBgNVBAoMBU5vc3RyMUgwRgYDVQQLDD9ucHViMXhkdGR1Y2RuamVyZXg4OGdrZzJxazJhdHNkbHFzeXhxYWFnNGgwNWptY3B5c3BxdDMwd3NjbW50eHkwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAATk4LYEsRVWZWQvqYeyREoIaf10MMs7QSYNZC5Lpi7fTJnn/p+A20WWbgWJhsUe5BXjbvw3SU9ZCZpGt5QhY3VJV9LiHbQs9cDk7LW0S3sl0rN/9X5RRLh96hvJzg9cR90wCgYIKoZIzj0EAwMDaAAwZQIxAJ1F+wpyeV0OKb94PRvVWELfhuiZ6w40xDahGuGmcFTkXe0YPviTo0uhB07XsibGVAIwdf5SZEn181+99J3GQoAWkimMy41c51IaezIY8hpstky8SDhRhOpdvgw2cyst7ciq"
    ],
    [
      "PCR8",
      "7e3f4c20f65f0a62de884a41ef73fd693c136173fec4ad19336d2ce3b1d63246da3383cbb83cd10dad77d5d1aafcdce1"
    ]
  ],
  "content": "",
  "sig": "17f87814835b14c3028789bfc76725a095bcceea59886dfce4dda487bb17eb76858794cdd354ae1f64be39c72ecb7c149e5093e94e7176425aa1214a556389af"
}
```

Matching `instance signature` example (from `instance` tag):
```
{
  "id": "ba52dbd7d4943068d10030f14b74dc3511698ecf53dff1190c446ffc0749d646",
  "created_at": 1743491523,
  "pubkey": "3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd",
  "kind": 63796,
  "tags": [
    [
      "-"
    ],
    [
      "t",
      "dev"
    ],
    [
      "PCR4",
      "6386cee86c94b2a713c98e1d883134e8f2c019a17a712eb950fde15e9d6667575569c4e5c5e66eb9c920369961025fd2"
    ]
  ],
  "content": "",
  "sig": "bd9c2278beb7cd0023e3e8cb8794e1d29ac76e28182cb54240c8f56752f92019233463a643c606362dc996d303db532df88633e1a53532ee0f23d724df89e1dd"
}
```

Anyone who discovers the `instance` event can validate the supplied `attestation` in the `content` against `build` and `instance` tags and decide if they are willing to trust the instance. They could then communicate to the `service pubkey` using a relay specified in the `relay` tag. Verification code prototype is available at [nostr-enclaves](https://github.com/nostrband/nostr-enclaves/blob/main/src/attestation.ts).

FIXME prod/dev build signature tags?

## Admin API

To import a key into `noauth-enclaved` you can use `nip46`-like protocol using `kind:24135` (instead of `kind:24133`). Requests must target `service pubkey` and must be signed by the `user key`. Methods:

| method            | params | result | description |
|-------------------|--------|--------|-------------|
| ping              | []     | "pong" | check if signer is alive |
| has_key           | []     | "true" OR "false" | check if caller's key is imported |
| import_key        | [`<privkey>`, `<comma-separated-nip46-relays>`]    | "ok" | import caller's key |
| connect_key       | [`<privkey>`, `<app_pubkey>`, `<comma-separated-nip46-relays>`]    | "ok" | import caller's key and connect to `app_pubkey` with full perms |
| delete_key        | []     | "ok"   | delete caller's key |
| generate_test_key | [`<comma-separated-nip46-relays>`] | `<bunker-url>` | create new key valid for 1 day with full perms and return bunker url |


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


// FIXME
- publishing build reproduction/review event
