package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workbench/internal/server"
)

func main() {
	configDir, err := os.UserConfigDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "workbench: unable to determine the user config directory: %v\n", err)
		os.Exit(1)
	}
	listen := flag.String("listen", "127.0.0.1:7690", "HTTP listen address")
	tmuxBin := flag.String("tmux", "tmux", "path to the tmux executable")
	gitRunner := flag.String("git-runner", "", "optional host Git/gh runner accepting tool, directory and arguments")
	allowRemote := flag.Bool("allow-remote", false, "allow listening on a non-loopback address (no built-in authentication)")
	filesystemRoot := flag.String("filesystem-root", "", "optional filesystem prefix for host-mounted session directories (e.g. /host)")
	stateDir := flag.String("state-dir", filepath.Join(configDir, "workbench"), "directory for persistent workspace groups and repository associations")
	flag.Parse()

	if _, err := exec.LookPath(*tmuxBin); err != nil {
		fmt.Fprintf(os.Stderr, "workbench: tmux executable not found: %v\n", err)
		os.Exit(1)
	}
	if !*allowRemote && !isLoopbackListenAddress(*listen) {
		fmt.Fprintln(os.Stderr, "workbench: refusing a non-loopback listen address without --allow-remote")
		fmt.Fprintln(os.Stderr, "workbench: use SSH port forwarding for remote access; see README.md")
		os.Exit(2)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{}))
	handler, err := server.NewWithGitOptions(*tmuxBin, logger, *filesystemRoot, *stateDir, *gitRunner)
	if err != nil {
		fmt.Fprintf(os.Stderr, "workbench: unable to initialize persistent state: %v\n", err)
		os.Exit(1)
	}
	httpServer := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-shutdown
		logger.Info("shutting down")
		_ = httpServer.Close()
	}()

	logger.Info("Workbench is ready", "url", "http://"+displayAddress(*listen))
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func isLoopbackListenAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func displayAddress(address string) string {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return address
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}
