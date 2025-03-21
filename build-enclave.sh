#!/bin/bash

docker load -i ./noauth_enclaved.tar

nitro-cli build-enclave --docker-uri noauth_enclaved:latest --output-file noauth_enclaved.eif

