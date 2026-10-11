package main

import "testing"

func TestIsLoopbackListenAddress(t *testing.T) {
	for _, address := range []string{"127.0.0.1:7681", "[::1]:7681", "localhost:7681"} {
		if !isLoopbackListenAddress(address) {
			t.Fatalf("expected %q to be loopback", address)
		}
	}
	for _, address := range []string{":7681", "0.0.0.0:7681", "192.0.2.1:7681"} {
		if isLoopbackListenAddress(address) {
			t.Fatalf("expected %q not to be loopback", address)
		}
	}
}
