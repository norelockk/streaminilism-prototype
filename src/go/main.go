package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/spf13/cobra"
)

type CLIConfig struct {
	StorageZone   string
	WriteKey      string
	Endpoint      string
	MaxConcurrent int
	RetryAttempts int
	RetryDelay    int
	ChunkSize     int64
	Verbose       bool
}

type WebSocketManager struct {
	clients    map[*websocket.Conn]bool
	msgChannel chan Message
	register   chan *websocket.Conn
	unregister chan *websocket.Conn
	upgrader   websocket.Upgrader
	uploads    *UploadManager
}

type Message struct {
	Type       string  `json:"type"`
	Message    string  `json:"message,omitempty"`
	File       string  `json:"file,omitempty"`
	RemotePath string  `json:"remotePath,omitempty"`
	Size       int64   `json:"size,omitempty"`
	Progress   float64 `json:"progress,omitempty"`
	Speed      float64 `json:"speed,omitempty"`
}

type ProgressReader struct {
	reader     io.Reader
	total      int64
	current    int64
	callback   func(float64, float64)
	startTime  time.Time
	lastUpdate time.Time
}

func (pr *ProgressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	if n > 0 {
		pr.current += int64(n)
		now := time.Now()

		if now.Sub(pr.lastUpdate) >= time.Second {
			progress := float64(pr.current) / float64(pr.total) * 100.0
			elapsed := now.Sub(pr.startTime).Seconds()
			speed := float64(pr.current) / elapsed / 1024 / 1024
			pr.callback(progress, speed)
			pr.lastUpdate = now
		}
	}
	return n, err
}

func formatSpeed(bytesPerSecond float64) string {
	const (
		KB = 1024
		MB = 1024 * KB
		GB = 1024 * MB
	)

	switch {
	case bytesPerSecond >= GB:
		return fmt.Sprintf("%.2f GB/s", bytesPerSecond/GB)
	case bytesPerSecond >= MB:
		return fmt.Sprintf("%.2f MB/s", bytesPerSecond/MB)
	default:
		return fmt.Sprintf("%.2f KB/s", bytesPerSecond/KB)
	}
}

type UploadManager struct {
	client        *Client
	config        *CLIConfig
	activeUploads sync.Map
	semaphore     chan struct{}
	wsManager     *WebSocketManager
}

func NewWebSocketManager(config *CLIConfig) (*WebSocketManager, error) {
	wsm := &WebSocketManager{
		clients:    make(map[*websocket.Conn]bool),
		msgChannel: make(chan Message),
		register:   make(chan *websocket.Conn),
		unregister: make(chan *websocket.Conn),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}

	um, err := NewUploadManager(config, wsm)
	if err != nil {
		return nil, err
	}
	wsm.uploads = um

	return wsm, nil
}

func NewUploadManager(config *CLIConfig, wsm *WebSocketManager) (*UploadManager, error) {
	cdnConfig := &Config{
		StorageZone: config.StorageZone,
		AccessKey:   config.WriteKey,
		Endpoint:    resolveEndpoint(config.Endpoint),
		Debug:       true,
	}

	client, err := NewClient(cdnConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create CDN client: %v", err)
	}

	return &UploadManager{
		client:    client,
		config:    config,
		semaphore: make(chan struct{}, config.MaxConcurrent),
		wsManager: wsm,
	}, nil
}

func (wsm *WebSocketManager) Start() {
	for {
		select {
		case client := <-wsm.register:
			wsm.clients[client] = true

		case client := <-wsm.unregister:
			if _, ok := wsm.clients[client]; ok {
				delete(wsm.clients, client)
				client.Close()
			}

		case message := <-wsm.msgChannel:
			for client := range wsm.clients {
				err := client.WriteJSON(message)
				if err != nil {
					client.Close()
					delete(wsm.clients, client)
				}
			}
		}
	}
}

func (wsm *WebSocketManager) sendMessage(message Message) {
	wsm.msgChannel <- message
}

func (wsm *WebSocketManager) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := wsm.upgrader.Upgrade(w, r, nil)
	if err != nil {
		fmt.Printf("WebSocket upgrade failed: %v\n", err)
		return
	}

	wsm.register <- conn

	go func() {
		defer func() {
			wsm.unregister <- conn
		}()

		for {
			var message Message
			err := conn.ReadJSON(&message)
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					fmt.Printf("WebSocket error: %v\n", err)
				}
				break
			}

			switch message.Type {
			case "upload":
				fmt.Printf("Starting upload for file: %s to path: %s\n", message.File, message.RemotePath)
				ctx, cancel := context.WithCancel(context.Background())
				wsm.uploads.activeUploads.Store(message.File, cancel)

				go func() {
					wsm.uploads.handleUpload(ctx, message)
					cancel()
					wsm.uploads.activeUploads.Delete(message.File)
				}()

			case "cancel":
				fmt.Printf("Cancelling upload for file: %s\n", message.File)
				if cancel, ok := wsm.uploads.activeUploads.Load(message.File); ok {
					cancel.(context.CancelFunc)()
					wsm.uploads.activeUploads.Delete(message.File)
				}

			case "batch_upload":
				fmt.Printf("Starting batch upload from directory: %s to path: %s\n", message.File, message.RemotePath)
				go wsm.uploads.handleBatchUpload(message)
			}
		}
	}()
}

func (um *UploadManager) handleUpload(ctx context.Context, message Message) {
	um.semaphore <- struct{}{}
	defer func() { <-um.semaphore }()

	fileInfo, err := os.Stat(message.File)
	if err != nil {
		fmt.Printf("Failed to get file info: %v\n", err)
		um.wsManager.sendMessage(Message{
			Type:       "upload_error",
			File:       message.File,
			Message:    fmt.Sprintf("Failed to get file info: %v", err),
			RemotePath: message.RemotePath,
		})
		return
	}

	remotePath := strings.ReplaceAll(message.RemotePath, "\\", "/")
	remotePath = strings.TrimPrefix(remotePath, "/")
	storageZonePrefix := um.config.StorageZone + "/"
	for strings.HasPrefix(remotePath, storageZonePrefix) {
		remotePath = strings.TrimPrefix(remotePath, storageZonePrefix)
	}

	remoteDir := filepath.Dir(remotePath)
	remoteDir = strings.ReplaceAll(remoteDir, "\\", "/")
	if remoteDir == "." {
		remoteDir = ""
	}
	filename := filepath.Base(remotePath)

	// Clean up any double slashes
	remoteDir = strings.ReplaceAll(remoteDir, "//", "/")

	fmt.Printf("Upload path details:\n")
	fmt.Printf("  Original path: %s\n", message.RemotePath)
	fmt.Printf("  Remote directory: %s\n", remoteDir)
	fmt.Printf("  Filename: %s\n", filename)
	fmt.Printf("  Storage Zone: %s\n", um.config.StorageZone)

	um.wsManager.sendMessage(Message{
		Type:       "upload_start",
		File:       message.File,
		Message:    "Starting upload",
		Size:       fileInfo.Size(),
		RemotePath: remotePath,
	})

	file, err := os.Open(message.File)
	if err != nil {
		fmt.Printf("Failed to open file: %v\n", err)
		um.wsManager.sendMessage(Message{
			Type:       "upload_error",
			File:       message.File,
			Message:    fmt.Sprintf("Failed to open file: %v", err),
			RemotePath: remotePath,
		})
		return
	}
	defer file.Close()

	fmt.Printf("Starting uploading %s (size: %s)\n", filename, formatSpeed(float64(fileInfo.Size())))

	for attempt := 0; attempt <= um.config.RetryAttempts; attempt++ {
		select {
		case <-ctx.Done():
			um.wsManager.sendMessage(Message{
				Type:       "upload_cancelled",
				File:       message.File,
				Message:    "Upload cancelled",
				RemotePath: remotePath,
			})
			return
		default:
			if attempt > 0 {
				um.wsManager.sendMessage(Message{
					Type:       "upload_retrying",
					File:       message.File,
					Message:    fmt.Sprintf("Retrying upload (attempt %d/%d)", attempt, um.config.RetryAttempts),
					RemotePath: remotePath,
				})
				time.Sleep(time.Duration(um.config.RetryDelay) * time.Millisecond)
				file.Seek(0, 0)
			}

			progressReader := &ProgressReader{
				reader:     file,
				total:      fileInfo.Size(),
				startTime:  time.Now(),
				lastUpdate: time.Now(),
				callback: func(progress, speed float64) {
					speedBytes := speed * 1024 * 1024

					um.wsManager.sendMessage(Message{
						Type:       "upload_progress",
						File:       message.File,
						Progress:   progress,
						Speed:      speedBytes,
						RemotePath: remotePath,
					})
				},
			}

			contentType := "application/octet-stream"
			ext := strings.ToLower(filepath.Ext(filename))
			switch ext {
			case ".ts":
				contentType = "video/MP2T"
			case ".mp4":
				contentType = "video/mp4"
			case ".m3u8":
				contentType = "application/x-mpegURL"
			}

			_, err = um.client.Upload(
				ctx,
				remoteDir,
				filename,
				contentType,
				progressReader,
			)

			if err == nil {
				fmt.Printf("Upload completed: %s (size: %s)", filename, formatSpeed(float64(fileInfo.Size())))

				um.wsManager.sendMessage(Message{
					Type:       "upload_complete",
					File:       message.File,
					Message:    "Upload completed successfully",
					Size:       fileInfo.Size(),
					RemotePath: remotePath,
				})
				return
			}

			if err != nil {
				fmt.Printf("Upload attempt %d failed with error: %v\n", attempt+1, err)
			}
		}
	}

	um.wsManager.sendMessage(Message{
		Type:       "upload_error",
		File:       message.File,
		Message:    fmt.Sprintf("Upload failed after %d attempts: %v", um.config.RetryAttempts+1, err),
		RemotePath: remotePath,
	})
}

func (um *UploadManager) handleBatchUpload(message Message) {
	dirInfo, err := os.Stat(message.File)
	if err != nil || !dirInfo.IsDir() {
		um.wsManager.sendMessage(Message{
			Type:       "batch_upload_error",
			File:       message.File,
			Message:    "Invalid directory",
			RemotePath: message.RemotePath,
		})
		return
	}

	um.wsManager.sendMessage(Message{
		Type:       "batch_upload_start",
		File:       message.File,
		Message:    "Starting batch upload",
		RemotePath: message.RemotePath,
	})

	var wg sync.WaitGroup
	errorChan := make(chan error, 100)

	err = filepath.Walk(message.File, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if info.IsDir() {
			return nil
		}

		wg.Add(1)
		go func(filePath string) {
			defer wg.Done()

			relPath, _ := filepath.Rel(message.File, filePath)
			remotePath := filepath.Join(message.RemotePath, relPath)
			remotePath = filepath.ToSlash(remotePath)

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			uploadMsg := Message{
				Type:       "upload",
				File:       filePath,
				RemotePath: remotePath,
			}

			um.handleUpload(ctx, uploadMsg)
		}(path)

		return nil
	})

	if err != nil {
		um.wsManager.sendMessage(Message{
			Type:       "batch_upload_error",
			File:       message.File,
			Message:    fmt.Sprintf("Error walking directory: %v", err),
			RemotePath: message.RemotePath,
		})
		return
	}

	wg.Wait()
	close(errorChan)

	um.wsManager.sendMessage(Message{
		Type:       "batch_upload_complete",
		File:       message.File,
		Message:    "Batch upload completed",
		RemotePath: message.RemotePath,
	})
}

func resolveEndpoint(endpoint string) Endpoint {
	switch endpoint {
	case "falkenstein":
		return EndpointFalkenstein
	case "los-angeles":
		return EndpointLosAngeles
	case "new-york":
		return EndpointNewYork
	case "singapore":
		return EndpointSingapore
	default:
		return EndpointFalkenstein
	}
}

func main() {
	config := &CLIConfig{
		MaxConcurrent: 5,
		RetryAttempts: 3,
		RetryDelay:    5000,
		ChunkSize:     64 * 1024 * 1024,
	}

	var wsPort int
	var wsManager *WebSocketManager

	rootCmd := &cobra.Command{
		Use: "bunny-upload",
		PersistentPreRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Initializing...")

			if config.StorageZone == "" || config.WriteKey == "" {
				fmt.Printf("Storage zone and write key are required\n")
				os.Exit(1)
			}

			var err error
			wsManager, err = NewWebSocketManager(config)
			if err != nil {
				fmt.Printf("Failed to create WebSocket manager: %v\n", err)
				os.Exit(1)
			}

			go wsManager.Start()
		},
		Run: func(cmd *cobra.Command, args []string) {
			http.HandleFunc("/ws", wsManager.HandleWebSocket)

			listener, err := net.Listen("tcp", fmt.Sprintf("localhost:%d", wsPort))
			if err != nil {
				fmt.Printf("Failed to start WebSocket server: %v\n", err)
				os.Exit(1)
			}

			fmt.Printf("WebSocket server listening on ws://localhost:%d/ws\n", wsPort)
			if err := http.Serve(listener, nil); err != nil {
				fmt.Printf("HTTP server error: %v\n", err)
				os.Exit(1)
			}
		},
	}

	rootCmd.PersistentFlags().StringVar(&config.StorageZone, "zone", "", "Bunny CDN Storage Zone (required)")
	rootCmd.PersistentFlags().StringVar(&config.WriteKey, "write-key", "", "Bunny CDN Write API Key (required)")
	rootCmd.PersistentFlags().StringVar(&config.Endpoint, "endpoint", "falkenstein", "Bunny CDN endpoint (falkenstein, los-angeles, new-york, singapore)")
	rootCmd.PersistentFlags().IntVar(&config.MaxConcurrent, "max-concurrent", 5, "Maximum number of concurrent uploads")
	rootCmd.PersistentFlags().IntVar(&config.RetryAttempts, "retry-attempts", 3, "Number of retry attempts for failed uploads")
	rootCmd.PersistentFlags().IntVar(&config.RetryDelay, "retry-delay", 5000, "Delay between retry attempts in milliseconds")
	rootCmd.PersistentFlags().Int64Var(&config.ChunkSize, "chunk-size", 16*1024*1024, "Upload chunk size in bytes")
	rootCmd.PersistentFlags().BoolVarP(&config.Verbose, "verbose", "v", false, "Verbose output")
	rootCmd.PersistentFlags().IntVar(&wsPort, "ws-port", 8002, "WebSocket server port")

	uploadCmd := &cobra.Command{
		Use:   "upload [local-file] [remote-path]",
		Short: "Upload a single file to Bunny CDN",
		Args:  cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			ctx := context.Background()
			wsManager.uploads.handleUpload(ctx, Message{
				Type:       "upload",
				File:       args[0],
				RemotePath: args[1],
			})
		},
	}

	batchUploadCmd := &cobra.Command{
		Use:   "batch-upload [local-directory] [remote-path]",
		Short: "Upload multiple files from a directory to Bunny CDN",
		Args:  cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			wsManager.uploads.handleBatchUpload(Message{
				Type:       "batch_upload",
				File:       args[0],
				RemotePath: args[1],
			})
		},
	}

	removeCmd := &cobra.Command{
		Use:   "remove [remote-file]",
		Short: "Remove a single file from Bunny CDN",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			remotePath := args[0]
			remotePath = strings.TrimPrefix(remotePath, "/")

			wsManager.sendMessage(Message{
				Type:    "remove_start",
				Message: "Starting file removal",
				File:    remotePath,
			})

			_, err := wsManager.uploads.client.Delete(
				context.Background(),
				config.StorageZone,
				remotePath,
			)

			if err != nil {
				wsManager.sendMessage(Message{
					Type:    "remove_error",
					Message: fmt.Sprintf("Remove failed: %v", err),
					File:    remotePath,
				})
				fmt.Printf("Remove failed: %v\n", err)
				os.Exit(1)
			}

			wsManager.sendMessage(Message{
				Type:    "remove_complete",
				Message: "File removed successfully",
				File:    remotePath,
			})

			if config.Verbose {
				fmt.Printf("Removed: %s\n", remotePath)
			}
		},
	}

	batchRemoveCmd := &cobra.Command{
		Use:   "batch-remove [file-list]",
		Short: "Remove multiple files from Bunny CDN using a file list",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			listFilePath := args[0]

			listFile, err := os.Open(listFilePath)
			if err != nil {
				fmt.Printf("Failed to open file list: %v\n", err)
				os.Exit(1)
			}
			defer listFile.Close()

			wsManager.sendMessage(Message{
				Type:    "batch_remove_start",
				Message: "Starting batch file removal",
				File:    listFilePath,
			})

			var wg sync.WaitGroup
			errorChan := make(chan error, 100)
			semaphore := make(chan struct{}, config.MaxConcurrent)

			var totalFiles int
			var removedFiles int
			var mu sync.Mutex

			scanner := bufio.NewScanner(listFile)
			for scanner.Scan() {
				remotePath := strings.TrimSpace(scanner.Text())
				if remotePath == "" {
					continue
				}

				remotePath = strings.TrimPrefix(remotePath, "/")
				mu.Lock()
				totalFiles++
				mu.Unlock()

				semaphore <- struct{}{}

				wg.Add(1)
				go func(path string) {
					defer wg.Done()
					defer func() { <-semaphore }()

					wsManager.sendMessage(Message{
						Type:    "remove_start",
						Message: "Starting file removal",
						File:    path,
					})

					_, err := wsManager.uploads.client.Delete(
						context.Background(),
						config.StorageZone,
						path,
					)

					if err != nil {
						errorChan <- fmt.Errorf("remove failed for %s: %v", path, err)
						wsManager.sendMessage(Message{
							Type:    "remove_error",
							Message: fmt.Sprintf("Remove failed: %v", err),
							File:    path,
						})
						return
					}

					mu.Lock()
					removedFiles++
					mu.Unlock()

					wsManager.sendMessage(Message{
						Type:    "remove_complete",
						Message: "File removed successfully",
						File:    path,
					})

					if config.Verbose {
						fmt.Printf("Removed: %s\n", path)
					}
				}(remotePath)
			}

			if err := scanner.Err(); err != nil {
				fmt.Printf("Error reading file list: %v\n", err)
				os.Exit(1)
			}

			go func() {
				wg.Wait()
				close(errorChan)
			}()

			var removeErrors []error
			for err := range errorChan {
				removeErrors = append(removeErrors, err)
				if config.Verbose {
					fmt.Printf("Remove error: %v\n", err)
				}
			}

			wsManager.sendMessage(Message{
				Type: "batch_remove_complete",
				Message: fmt.Sprintf("Batch file removal completed. Total: %d, Removed: %d, Failed: %d",
					totalFiles, removedFiles, len(removeErrors)),
				File: listFilePath,
			})
		},
	}

	rootCmd.AddCommand(uploadCmd, batchUploadCmd, removeCmd, batchRemoveCmd)

	if err := rootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
