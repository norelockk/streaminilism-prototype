package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Endpoint int

const (
	EndpointFalkenstein Endpoint = iota
	EndpointLosAngeles
	EndpointNewYork
	EndpointSingapore
)

func (e Endpoint) String() string {
	return getEndpointString(e)
}

func getEndpointString(e Endpoint) string {
	switch e {
	case EndpointFalkenstein:
		return "de"
	case EndpointLosAngeles:
		return "la"
	case EndpointNewYork:
		return "ny"
	case EndpointSingapore:
		return "sg"
	default:
		return "de"
	}
}

type StorageError struct {
	Message string
}

func (e *StorageError) Error() string {
	return e.Message
}

type AuthError struct {
	StorageZone string
	AccessKey   string
}

func (e *AuthError) Error() string {
	return fmt.Sprintf("authentication failed for storage zone '%s' with access key '%s'", e.StorageZone, e.AccessKey)
}

type FileNotFoundError struct {
	Path string
}

func (e *FileNotFoundError) Error() string {
	return fmt.Sprintf("could not find part of the object path: %s", e.Path)
}

type ChecksumError struct {
	Path     string
	Checksum string
}

func (e *ChecksumError) Error() string {
	return fmt.Sprintf("upload checksum verification failed for '%s' using checksum '%s'", e.Path, e.Checksum)
}

type StorageObject struct {
	Guid            string    `json:"guid"`
	UserID          string    `json:"userId"`
	DateCreated     time.Time `json:"dateCreated"`
	LastChanged     time.Time `json:"lastChanged"`
	StorageZoneName string    `json:"storageZoneName"`
	Path            string    `json:"path"`
	ObjectName      string    `json:"objectName"`
	Length          int64     `json:"length"`
	IsDirectory     bool      `json:"isDirectory"`
	ServerID        int       `json:"serverId"`
	StorageZoneID   int64     `json:"storageZoneId"`
}

func (o *StorageObject) FullPath() string {
	return o.Path + o.ObjectName
}

type Client struct {
	httpClient  *http.Client
	accessKey   string
	storageZone string
	baseURL     string
}

type Config struct {
	AccessKey   string
	StorageZone string
	Endpoint    Endpoint
	Debug       bool
}

func NewClient(cfg *Config) (*Client, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}

	baseURL := "https://storage.bunnycdn.com/"
	if region := getEndpointString(cfg.Endpoint); region != "de" {
		baseURL = fmt.Sprintf("https://%s.storage.bunnycdn.com/", region)
	}

	return &Client{
		httpClient:  &http.Client{Timeout: 600 * time.Second},
		accessKey:   cfg.AccessKey,
		storageZone: cfg.StorageZone,
		baseURL:     baseURL,
	}, nil
}

func (c *Client) Upload(ctx context.Context, path string, filename string, contentType string, content io.Reader) (*http.Response, error) {
	if !strings.HasPrefix(path, c.storageZone+"/") {
		path = fmt.Sprintf("%s/%s", c.storageZone, path)
	}

	path = strings.TrimPrefix(path, "/")
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimSuffix(path, "/")

	// If path is empty, just use the filename
	if path == "" {
		path = filename
	} else {
		path = fmt.Sprintf("%s/%s", path, filename)
	}

	url := c.baseURL + path

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, content)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	// Set headers
	req.Header.Set("AccessKey", c.accessKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, fmt.Errorf("upload failed: %s - %s", resp.Status, string(body))
	}

	return resp, nil
}

func (c *Client) Delete(ctx context.Context, path string, filename string) (*http.Response, error) {
	path = c.normalizePath(path, filename)
	url := c.baseURL + path

	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("AccessKey", c.accessKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, fmt.Errorf("delete failed: %s - %s", resp.Status, string(body))
	}

	return resp, nil
}

func (c *Client) ListObjects(ctx context.Context, path string) ([]*StorageObject, error) {
	path = c.normalizePath(path, "")
	if !strings.HasSuffix(path, "/") {
		path += "/"
	}

	url := c.baseURL + path

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("AccessKey", c.accessKey)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list failed: %s - %s", resp.Status, string(body))
	}

	var objects []*StorageObject
	if err := json.NewDecoder(resp.Body).Decode(&objects); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}

	return objects, nil
}

func (c *Client) Download(ctx context.Context, path string, filename string) (io.ReadCloser, error) {
	path = c.normalizePath(path, filename)
	url := c.baseURL + path

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("AccessKey", c.accessKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("download failed: %s - %s", resp.Status, string(body))
	}

	return resp.Body, nil
}

func (c *Client) normalizePath(path, filename string) string {
	// Normalize slashes
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimPrefix(path, "/")
	path = strings.TrimSuffix(path, "/")

	// Ensure storage zone prefix
	if !strings.HasPrefix(path, c.storageZone+"/") {
		path = c.storageZone + "/" + path
	}

	// Add filename if provided
	if filename != "" {
		path = path + "/" + filename
	}

	// Remove double slashes
	for strings.Contains(path, "//") {
		path = strings.ReplaceAll(path, "//", "/")
	}

	return path
}

func CalculateChecksum(content io.Reader) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, content); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
