package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ==========================================
// CONFIGURATION & ENVIRONMENT (.env)
// ==========================================

type AppConfig struct {
	ProxyURL        string
	Connections     int
	MaxRetries      int
	UserAgent       string
	SearchMirrors   []string
	DownloadGateways []string
}

var Config AppConfig

// Default failover mirrors
var defaultSearchMirrors = []string{
	"https://libgen.li",
	"https://libgen.is",
	"https://libgen.rs",
	"https://libgen.st",
}

var defaultDownloadGateways = []string{
	"https://library.lol",
	"http://library.lol",
}

func loadEnvFile(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			k := strings.TrimSpace(parts[0])
			v := strings.TrimSpace(parts[1])
			if os.Getenv(k) == "" {
				os.Setenv(k, v)
			}
		}
	}
}

func initConfig() {
	loadEnvFile("config.env")
	loadEnvFile(".env")
	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		loadEnvFile(filepath.Join(exeDir, "config.env"))
		loadEnvFile(filepath.Join(exeDir, ".env"))
	}

	Config.ProxyURL = os.Getenv("HTTP_PROXY")
	if Config.ProxyURL == "" {
		Config.ProxyURL = os.Getenv("HTTPS_PROXY")
	}

	conns := 3
	if val := os.Getenv("DOWNLOAD_CONNECTIONS"); val != "" {
		if c, err := strconv.Atoi(val); err == nil && c > 0 {
			conns = c
		}
	}
	Config.Connections = conns

	retries := 5
	if val := os.Getenv("DOWNLOAD_MAX_RETRIES"); val != "" {
		if r, err := strconv.Atoi(val); err == nil && r > 0 {
			retries = r
		}
	}
	Config.MaxRetries = retries

	ua := os.Getenv("USER_AGENT")
	if ua == "" {
		ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
	}
	Config.UserAgent = ua

	// Configurable Search Mirrors via .env
	if val := os.Getenv("SEARCH_MIRRORS"); val != "" {
		var mirrors []string
		for _, m := range strings.Split(val, ",") {
			m = strings.TrimSpace(m)
			if m != "" {
				mirrors = append(mirrors, strings.TrimRight(m, "/"))
			}
		}
		if len(mirrors) > 0 {
			Config.SearchMirrors = mirrors
		}
	}
	if len(Config.SearchMirrors) == 0 {
		Config.SearchMirrors = defaultSearchMirrors
	}

	// Configurable Download Gateways via .env
	if val := os.Getenv("DOWNLOAD_GATEWAYS"); val != "" {
		var gateways []string
		for _, g := range strings.Split(val, ",") {
			g = strings.TrimSpace(g)
			if g != "" {
				gateways = append(gateways, strings.TrimRight(g, "/"))
			}
		}
		if len(gateways) > 0 {
			Config.DownloadGateways = gateways
		}
	}
	if len(Config.DownloadGateways) == 0 {
		Config.DownloadGateways = defaultDownloadGateways
	}
}

func logDebug(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[LdBook] "+format+"\n", args...)
}

// ==========================================
// PRE-COMPILED REGULAR EXPRESSIONS (High-Perf Optimization)
// ==========================================

var (
	reHtmlTag    = regexp.MustCompile(`<[^>]*>`)
	reSanitize   = regexp.MustCompile(`[\\/:*?"<>|]`)
	reBrackets   = regexp.MustCompile(`[（\(【\[][^）\)】\]]*[）\)】\]]`)
	rePunct      = regexp.MustCompile(`[：:;,\-_—\.\s]+`)
	reRow        = regexp.MustCompile(`(?s)<tr>(.*?)</tr>`)
	reMD5Li      = regexp.MustCompile(`(?i)(?:ads\.php\?md5=|\/ads\/|\/md5\/|md5=)([a-fA-F0-9]{32})`)
	reTitleLi    = regexp.MustCompile(`(?s)href=["']edition\.php\?id=\d+["']>([^<]+)`)
	reCols       = regexp.MustCompile(`(?s)<td[^>]*>(.*?)</td>`)
	reRowIs      = regexp.MustCompile(`(?s)<tr valign="top"[^>]*>(.*?)</tr>`)
	reMD5Is      = regexp.MustCompile(`(?i)[?&]md5=([a-fA-F0-9]{32})`)
	reTitleIs    = regexp.MustCompile(`(?s)<a[^>]*id=["']\d+["'][^>]*>(.*?)</a>|<a[^>]*href=["']book/index\.php\?md5=[^"']*["'][^>]*>(.*?)</a>`)
	reLolLink    = regexp.MustCompile(`(?i)<a[^>]*href=["'](https?://[^"']*(?:get\.php|\.pdf|\.epub|\.mobi|\.azw3|\.djvu|\.txt)[^"']*)["'][^>]*>GET</a>|<a[^>]*href=["'](https?://[^"']*(?:get\.php|\.pdf|\.epub|\.mobi|\.txt)[^"']*)["']`)
	reLiKeyLink  = regexp.MustCompile(`href=["']([^"']*get\.php\?md5=[^"']*key=[^"']+)["']`)
	reCdFilename = regexp.MustCompile(`(?i)filename=["']?[^"']*\.([a-zA-Z0-9]{2,6})["']?`)
)

// ==========================================
// HTTP CLIENT POOL (High Performance Keep-Alive)
// ==========================================

var (
	sharedTransport *http.Transport
	sharedJar       http.CookieJar
	clientOnce      sync.Once
)

func getSharedTransport() *http.Transport {
	clientOnce.Do(func() {
		jar, _ := cookiejar.New(nil)
		sharedJar = jar

		proxyFunc := http.ProxyFromEnvironment
		if Config.ProxyURL != "" {
			if parsed, err := url.Parse(Config.ProxyURL); err == nil {
				proxyFunc = http.ProxyURL(parsed)
			}
		}

		sharedTransport = &http.Transport{
			Proxy: proxyFunc,
			DialContext: (&net.Dialer{
				Timeout:   15 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          128,
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true,
			},
		}
	})
	return sharedTransport
}

func getHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Jar:       sharedJar,
		Transport: getSharedTransport(),
		Timeout:   timeout,
	}
}

func setCommonHeaders(req *http.Request) {
	req.Header.Set("User-Agent", Config.UserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7")
	req.Header.Set("Sec-Ch-Ua", `"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"`)
	req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
	req.Header.Set("Sec-Ch-Ua-Platform", `"Windows"`)
	req.Header.Set("Sec-Fetch-Dest", "document")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Site", "none")
	req.Header.Set("Sec-Fetch-User", "?1")
	req.Header.Set("Upgrade-Insecure-Requests", "1")
}

// ==========================================
// DATA MODELS & AGGREGATION
// ==========================================

type BookItem struct {
	ID        string `json:"id"`
	MD5       string `json:"md5"`
	Title     string `json:"title"`
	Author    string `json:"author"`
	Year      string `json:"year"`
	Extension string `json:"extension"`
	Size      string `json:"size"`
	Source    string `json:"source"`
	URL       string `json:"url"`
}

type GroupedBook struct {
	Title            string            `json:"title"`
	Author           string            `json:"author"`
	Year             string            `json:"year"`
	AvailableFormats []string          `json:"availableFormats"`
	FormatMD5Map     map[string]string `json:"formatMD5Map"` // extension -> md5
	BestMD5          string            `json:"bestMD5"`
	BestFormat       string            `json:"bestFormat"`
	Size             string            `json:"size"`
}

type SearchResponse struct {
	TargetFormat     string        `json:"targetFormat,omitempty"`
	FormatFound      bool          `json:"formatFound"`
	GlobalFormats    []string      `json:"globalFormats"`
	TotalUniqueBooks int           `json:"totalUniqueBooks"`
	Books            []GroupedBook `json:"books"`
	Notice           string        `json:"notice,omitempty"`
}

type SmartFetchResponse struct {
	Status           string        `json:"status"` // "downloaded" or "multiple_choices" or "not_found"
	FilePath         string        `json:"filePath,omitempty"`
	SelectedBook     *GroupedBook  `json:"selectedBook,omitempty"`
	AvailableBooks   []GroupedBook `json:"availableBooks,omitempty"`
	AvailableFormats []string      `json:"availableFormats,omitempty"`
	Message          string        `json:"message"`
}

// ==========================================
// TITLE NORMALIZATION & RELEVANCE SCORING
// ==========================================

func normalizeTitle(title string) string {
	t := strings.ToLower(title)
	t = reBrackets.ReplaceAllString(t, " ")
	t = rePunct.ReplaceAllString(t, " ")
	return strings.TrimSpace(t)
}

func calculateRelevanceScore(bookTitle, author, query string) int {
	cleanQuery := strings.ToLower(strings.TrimSpace(query))
	cleanTitle := strings.ToLower(strings.TrimSpace(bookTitle))
	normTitle := normalizeTitle(bookTitle)

	score := 0

	if cleanTitle == cleanQuery || normTitle == cleanQuery {
		score += 1000
	} else if strings.HasPrefix(cleanTitle, cleanQuery) || strings.HasPrefix(normTitle, cleanQuery) {
		score += 500
	} else if strings.Contains(cleanTitle, cleanQuery) {
		score += 300
	}

	cleanAuthor := strings.ToLower(strings.TrimSpace(author))
	if cleanAuthor == cleanQuery {
		score += 800
	} else if strings.Contains(cleanAuthor, cleanQuery) {
		score += 400
	}

	derivatives := []string{"明信片", "同人", "解析", "前传", "指南", "解读", "书评", "合订本"}
	for _, d := range derivatives {
		if strings.Contains(cleanTitle, d) && !strings.Contains(cleanQuery, d) {
			score -= 200
		}
	}

	diffLen := len(cleanTitle) - len(cleanQuery)
	if diffLen > 0 {
		score -= diffLen
	}

	return score
}

// ==========================================
// 1. ALL-MIRRORS ASYNC SEARCH
// ==========================================

func SearchBooks(query string, formatFilter string, searchField string, count int) (*SearchResponse, error) {
	if count <= 0 {
		count = 10
	}
	targetExt := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(formatFilter), "."))
	if searchField == "" {
		searchField = "def"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	resultChan := make(chan []BookItem, len(Config.SearchMirrors))
	var wg sync.WaitGroup

	for _, m := range Config.SearchMirrors {
		mirrorURL := m
		wg.Add(1)
		go func(mirror string) {
			defer wg.Done()
			books, err := searchSingleLibgenMirror(ctx, mirror, query, searchField)
			if err == nil && len(books) > 0 {
				select {
				case resultChan <- books:
				case <-ctx.Done():
				}
			}
		}(mirrorURL)
	}

	go func() {
		wg.Wait()
		close(resultChan)
	}()

	var rawItems []BookItem
	seenMD5 := make(map[string]bool)

	for items := range resultChan {
		for _, b := range items {
			if !seenMD5[b.MD5] {
				seenMD5[b.MD5] = true
				rawItems = append(rawItems, b)
			}
		}

		if targetExt != "" {
			matchedCount := 0
			for _, item := range rawItems {
				if strings.EqualFold(item.Extension, targetExt) {
					matchedCount++
				}
			}
			if matchedCount >= count*2 {
				logDebug("Satisfied candidate count for format '%s'. Cancelling remaining mirror searches!", targetExt)
				cancel()
				break
			}
		}
	}

	if len(rawItems) == 0 {
		return nil, fmt.Errorf("no books found for '%s'", query)
	}

	type bookKey struct {
		normTitle string
		author    string
	}
	groupMap := make(map[bookKey]*GroupedBook)
	var orderedKeys []bookKey
	globalFormatMap := make(map[string]bool)

	for _, item := range rawItems {
		ext := strings.ToLower(item.Extension)
		if ext != "" {
			globalFormatMap[ext] = true
		}

		k := bookKey{
			normTitle: normalizeTitle(item.Title),
			author:    strings.TrimSpace(item.Author),
		}

		if gb, exists := groupMap[k]; exists {
			if !containsString(gb.AvailableFormats, ext) && ext != "" {
				gb.AvailableFormats = append(gb.AvailableFormats, ext)
				gb.FormatMD5Map[ext] = item.MD5
			}
			if targetExt != "" && ext == targetExt {
				gb.BestMD5 = item.MD5
				gb.BestFormat = ext
			}
		} else {
			formats := []string{}
			fmtMap := make(map[string]string)
			if ext != "" {
				formats = append(formats, ext)
				fmtMap[ext] = item.MD5
			}
			gb := &GroupedBook{
				Title:            item.Title,
				Author:           item.Author,
				Year:             item.Year,
				AvailableFormats: formats,
				FormatMD5Map:     fmtMap,
				BestMD5:          item.MD5,
				BestFormat:       ext,
				Size:             item.Size,
			}
			groupMap[k] = gb
			orderedKeys = append(orderedKeys, k)
		}
	}

	var groupedBooks []GroupedBook
	for _, k := range orderedKeys {
		gb := groupMap[k]
		sort.Strings(gb.AvailableFormats)
		groupedBooks = append(groupedBooks, *gb)
	}

	sort.SliceStable(groupedBooks, func(i, j int) bool {
		scoreI := calculateRelevanceScore(groupedBooks[i].Title, groupedBooks[i].Author, query)
		scoreJ := calculateRelevanceScore(groupedBooks[j].Title, groupedBooks[j].Author, query)
		return scoreI > scoreJ
	})

	var globalFormats []string
	for fmtName := range globalFormatMap {
		globalFormats = append(globalFormats, fmtName)
	}
	sort.Strings(globalFormats)

	resp := &SearchResponse{
		TargetFormat:     targetExt,
		GlobalFormats:    globalFormats,
		TotalUniqueBooks: len(groupedBooks),
	}

	if targetExt != "" {
		var matched []GroupedBook
		for _, gb := range groupedBooks {
			if containsString(gb.AvailableFormats, targetExt) {
				if md5, ok := gb.FormatMD5Map[targetExt]; ok {
					gb.BestMD5 = md5
					gb.BestFormat = targetExt
				}
				matched = append(matched, gb)
			}
		}

		if len(matched) > 0 {
			resp.FormatFound = true
			if len(matched) > count {
				matched = matched[:count]
			}
			resp.Books = matched
			resp.Notice = fmt.Sprintf("Found %d distinct book(s) supporting requested '%s' format.", len(matched), targetExt)
		} else {
			resp.FormatFound = false
			resp.Books = []GroupedBook{}
			resp.Notice = fmt.Sprintf("No books found with format '%s'. However, available formats are: [%s]. Please pick one of the available formats.",
				targetExt, strings.Join(globalFormats, ", "))
		}
	} else {
		resp.FormatFound = true
		if len(groupedBooks) > count {
			groupedBooks = groupedBooks[:count]
		}
		resp.Books = groupedBooks
		resp.Notice = fmt.Sprintf("Found %d unique title(s). Available formats: [%s].", len(groupedBooks), strings.Join(globalFormats, ", "))
	}

	return resp, nil
}

func containsString(slice []string, s string) bool {
	for _, item := range slice {
		if strings.EqualFold(item, s) {
			return true
		}
	}
	return false
}

// DownloadDirectBook searches for a book with explicit format and automatically downloads the best candidate directly
func DownloadDirectBook(query, format, searchField, outputDir string) (*SmartFetchResponse, error) {
	if format == "" {
		format = "epub"
	}
	format = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(format), "."))

	searchResp, err := SearchBooks(query, format, searchField, 10)
	if err != nil {
		return nil, fmt.Errorf("direct download search failed: %w", err)
	}

	if !searchResp.FormatFound || len(searchResp.Books) == 0 {
		return nil, fmt.Errorf("book '%s' is not available in requested format '%s'. Available formats: [%s]",
			query, format, strings.Join(searchResp.GlobalFormats, ", "))
	}

	targetBook := searchResp.Books[0]
	targetMD5 := targetBook.BestMD5
	if md5, ok := targetBook.FormatMD5Map[format]; ok {
		targetMD5 = md5
	}

	logDebug("Direct download selected top ranked book '%s' by '%s' (%s, MD5: %s)", targetBook.Title, targetBook.Author, format, targetMD5)
	savedPath, err := DownloadBookToFile(targetMD5, targetBook.Title, format, outputDir)
	if err != nil {
		return nil, fmt.Errorf("failed to download book file: %w", err)
	}

	selected := targetBook
	return &SmartFetchResponse{
		Status:       "downloaded",
		FilePath:     savedPath,
		SelectedBook: &selected,
		Message:      fmt.Sprintf("Directly downloaded '%s' (%s) to %s", targetBook.Title, format, savedPath),
	}, nil
}

// SmartFetchBook executes the two-stage decision
func SmartFetchBook(query, format, searchField, outputDir string) (*SmartFetchResponse, error) {
	searchResp, err := SearchBooks(query, format, searchField, 15)
	if err != nil {
		return &SmartFetchResponse{
			Status:  "not_found",
			Message: fmt.Sprintf("Search error: %v", err),
		}, nil
	}

	if format != "" && !searchResp.FormatFound {
		return &SmartFetchResponse{
			Status:           "multiple_choices",
			AvailableFormats: searchResp.GlobalFormats,
			Message: fmt.Sprintf("Requested format '%s' is not available. Available formats are: [%s].",
				format, strings.Join(searchResp.GlobalFormats, ", ")),
		}, nil
	}

	books := searchResp.Books
	if len(books) == 0 {
		return &SmartFetchResponse{
			Status:  "not_found",
			Message: fmt.Sprintf("No books found for '%s'", query),
		}, nil
	}

	cleanQuery := strings.ToLower(strings.TrimSpace(query))
	isExactMatch := false

	if len(books) == 1 && format != "" {
		isExactMatch = true
	} else if format != "" {
		top := books[0]
		normTop := normalizeTitle(top.Title)
		if normTop == cleanQuery || strings.EqualFold(top.Title, cleanQuery) {
			isExactMatch = true
		}
	}

	if isExactMatch {
		first := books[0]
		targetMD5 := first.BestMD5
		if md5, ok := first.FormatMD5Map[strings.ToLower(format)]; ok {
			targetMD5 = md5
		}

		logDebug("Unambiguous target match '%s' (%s, MD5: %s). Auto-downloading directly...", first.Title, format, targetMD5)
		savedPath, err := DownloadBookToFile(targetMD5, first.Title, format, outputDir)
		if err != nil {
			return nil, err
		}
		return &SmartFetchResponse{
			Status:       "downloaded",
			FilePath:     savedPath,
			SelectedBook: &first,
			Message:      fmt.Sprintf("Successfully downloaded '%s' (%s) to %s", first.Title, format, savedPath),
		}, nil
	}

	return &SmartFetchResponse{
		Status:           "multiple_choices",
		AvailableBooks:   books,
		AvailableFormats: searchResp.GlobalFormats,
		Message: fmt.Sprintf("Found %d distinct book(s). Each book item displays its author and all supported formats. Pick one book title + format to download.",
			len(books)),
	}, nil
}

func searchSingleLibgenMirror(ctx context.Context, mirror, query, searchField string) ([]BookItem, error) {
	client := getHTTPClient(15 * time.Second)

	var searchURL string
	if strings.Contains(mirror, "libgen.li") {
		params := url.Values{}
		params.Set("req", query)
		if searchField != "" && searchField != "def" {
			params.Set("column", searchField)
		}
		searchURL = fmt.Sprintf("%s/index.php?%s", mirror, params.Encode())
	} else {
		params := url.Values{}
		params.Set("req", query)
		params.Set("res", "25")
		params.Set("column", searchField)
		searchURL = fmt.Sprintf("%s/search.php?%s", mirror, params.Encode())
	}

	req, err := http.NewRequestWithContext(ctx, "GET", searchURL, nil)
	if err != nil {
		return nil, err
	}
	setCommonHeaders(req)

	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mirror error")
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	pageText := string(bodyBytes)
	if strings.Contains(pageText, "Welcome to nginx!") {
		return nil, fmt.Errorf("nginx default page")
	}

	if strings.Contains(mirror, "libgen.li") {
		return parseLibgenLiHTML(pageText, mirror), nil
	}
	return parseLibgenIsHTML(pageText, mirror), nil
}

func parseLibgenLiHTML(htmlText, mirror string) []BookItem {
	var results []BookItem
	seen := make(map[string]bool)

	tbodyStart := strings.Index(htmlText, "<tbody>")
	if tbodyStart == -1 {
		return results
	}
	tbodyEnd := strings.Index(htmlText[tbodyStart:], "</tbody>")
	if tbodyEnd == -1 {
		return results
	}
	tbodyText := htmlText[tbodyStart : tbodyStart+tbodyEnd]

	rows := reRow.FindAllStringSubmatch(tbodyText, -1)
	for _, r := range rows {
		rowContent := r[1]
		md5Match := reMD5Li.FindStringSubmatch(rowContent)
		if len(md5Match) < 2 {
			continue
		}
		md5 := strings.ToLower(md5Match[1])
		if seen[md5] {
			continue
		}

		title := ""
		titleMatches := reTitleLi.FindAllStringSubmatch(rowContent, -1)
		for _, tm := range titleMatches {
			cleaned := cleanHTML(tm[1])
			if cleaned != "" && !strings.Contains(cleaned, "978") {
				title = cleaned
				break
			}
		}
		if title == "" && len(titleMatches) > 0 {
			title = cleanHTML(titleMatches[0][1])
		}
		if title == "" {
			continue
		}

		cols := reCols.FindAllStringSubmatch(rowContent, -1)
		author, year, size, ext := "", "", "", ""
		if len(cols) >= 8 {
			author = cleanHTML(cols[1][1])
			year = cleanHTML(cols[3][1])
			size = cleanHTML(cols[6][1])
			ext = strings.ToLower(cleanHTML(cols[7][1]))
		}

		seen[md5] = true
		results = append(results, BookItem{
			ID:        md5,
			MD5:       md5,
			Title:     title,
			Author:    author,
			Year:      year,
			Size:      size,
			Extension: ext,
			Source:    "libgen",
			URL:       fmt.Sprintf("%s/ads.php?md5=%s", mirror, md5),
		})
	}
	return results
}

func parseLibgenIsHTML(htmlText, mirror string) []BookItem {
	var results []BookItem
	seen := make(map[string]bool)

	rows := reRowIs.FindAllStringSubmatch(htmlText, -1)
	for _, r := range rows {
		rowContent := r[1]
		md5Match := reMD5Is.FindStringSubmatch(rowContent)
		if len(md5Match) < 2 {
			continue
		}
		md5 := strings.ToLower(md5Match[1])
		if seen[md5] {
			continue
		}

		var title string
		if tm := reTitleIs.FindStringSubmatch(rowContent); len(tm) > 0 {
			for i := 1; i < len(tm); i++ {
				if tm[i] != "" {
					title = cleanHTML(tm[i])
					break
				}
			}
		}
		if title == "" || len(title) < 2 {
			continue
		}

		cols := reCols.FindAllStringSubmatch(rowContent, -1)
		author, year, size, ext := "", "", "", ""
		if len(cols) >= 9 {
			author = cleanHTML(cols[1][1])
			year = cleanHTML(cols[4][1])
			size = cleanHTML(cols[7][1])
			ext = strings.ToLower(cleanHTML(cols[8][1]))
		}

		seen[md5] = true
		results = append(results, BookItem{
			ID:        md5,
			MD5:       md5,
			Title:     title,
			Author:    author,
			Year:      year,
			Size:      size,
			Extension: ext,
			Source:    "libgen",
			URL:       fmt.Sprintf("%s/book/index.php?md5=%s", mirror, md5),
		})
	}
	return results
}

// ==========================================
// 2. CONCURRENT DOWNLOAD URL RESOLVER
// ==========================================

func ResolveDownloadLink(md5 string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	resultChan := make(chan string, len(Config.DownloadGateways)+len(Config.SearchMirrors))
	var wg sync.WaitGroup

	// Strategy 1: Gateways (e.g. library.lol)
	for _, gw := range Config.DownloadGateways {
		wg.Add(1)
		go func(gateway string) {
			defer wg.Done()
			client := getHTTPClient(10 * time.Second)
			reqURL := fmt.Sprintf("%s/main/%s", gateway, md5)
			req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
			if err != nil {
				return
			}
			setCommonHeaders(req)

			resp, err := client.Do(req)
			if err != nil || resp.StatusCode != http.StatusOK {
				return
			}
			defer resp.Body.Close()

			bodyBytes, err := io.ReadAll(resp.Body)
			if err != nil {
				return
			}

			page := string(bodyBytes)
			if m := reLolLink.FindStringSubmatch(page); len(m) > 1 {
				for i := 1; i < len(m); i++ {
					if m[i] != "" {
						select {
						case resultChan <- m[i]:
							cancel()
						case <-ctx.Done():
						}
						return
					}
				}
			}
		}(gw)
	}

	// Strategy 2: Mirrors ads.php (e.g. libgen.li/ads.php)
	for _, m := range Config.SearchMirrors {
		if strings.Contains(m, "libgen.li") {
			mirrorBase := m
			wg.Add(1)
			go func(baseMirror string) {
				defer wg.Done()
				client := getHTTPClient(10 * time.Second)
				reqURL := fmt.Sprintf("%s/ads.php?md5=%s", baseMirror, md5)
				req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
				if err != nil {
					return
				}
				setCommonHeaders(req)

				resp, err := client.Do(req)
				if err != nil || resp.StatusCode != http.StatusOK {
					return
				}
				defer resp.Body.Close()

				bodyBytes, err := io.ReadAll(resp.Body)
				if err != nil {
					return
				}

				if km := reLiKeyLink.FindStringSubmatch(string(bodyBytes)); len(km) > 1 {
					keyLink := km[1]
					if strings.HasPrefix(keyLink, "http") {
						select {
						case resultChan <- keyLink:
							cancel()
						case <-ctx.Done():
						}
						return
					}
					base, _ := url.Parse(baseMirror)
					rel, _ := url.Parse(keyLink)
					select {
					case resultChan <- base.ResolveReference(rel).String():
						cancel()
					case <-ctx.Done():
					}
				}
			}(mirrorBase)
		}
	}

	go func() {
		wg.Wait()
		close(resultChan)
	}()

	for directURL := range resultChan {
		if directURL != "" {
			return directURL, nil
		}
	}

	return "", fmt.Errorf("failed to resolve download URL for MD5 %s across all mirrors/gateways", md5)
}

// ==========================================
// 3. ROBUST RESUMABLE DOWNLOADER
// ==========================================

type DownloadProbe struct {
	ContentLength int64
	AcceptRanges  bool
	RedirectURL   string
	RealExtension string
}

func probeDownloadURL(rawURL string) (*DownloadProbe, error) {
	client := getHTTPClient(20 * time.Second)

	req, err := http.NewRequest("HEAD", rawURL, nil)
	if err != nil {
		return nil, err
	}
	setCommonHeaders(req)

	resp, err := client.Do(req)
	if err == nil && (resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent) {
		defer resp.Body.Close()
		ranges := strings.Contains(strings.ToLower(resp.Header.Get("Accept-Ranges")), "bytes")
		realExt := extractExtensionFromHeader(resp.Header.Get("Content-Disposition"), resp.Request.URL.Path)
		return &DownloadProbe{
			ContentLength: resp.ContentLength,
			AcceptRanges:  ranges,
			RedirectURL:   resp.Request.URL.String(),
			RealExtension: realExt,
		}, nil
	}

	reqRange, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	setCommonHeaders(reqRange)
	reqRange.Header.Set("Range", "bytes=0-0")

	respRange, err := client.Do(reqRange)
	if err != nil {
		return nil, err
	}
	defer respRange.Body.Close()

	realExt := extractExtensionFromHeader(respRange.Header.Get("Content-Disposition"), respRange.Request.URL.Path)

	if respRange.StatusCode == http.StatusPartialContent {
		totalSize := int64(0)
		cr := respRange.Header.Get("Content-Range")
		if parts := strings.Split(cr, "/"); len(parts) == 2 {
			if size, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
				totalSize = size
			}
		}
		return &DownloadProbe{
			ContentLength: totalSize,
			AcceptRanges:  true,
			RedirectURL:   respRange.Request.URL.String(),
			RealExtension: realExt,
		}, nil
	}

	return &DownloadProbe{
		ContentLength: respRange.ContentLength,
		AcceptRanges:  false,
		RedirectURL:   respRange.Request.URL.String(),
		RealExtension: realExt,
	}, nil
}

func extractExtensionFromHeader(cd, path string) string {
	if cd != "" {
		if m := reCdFilename.FindStringSubmatch(cd); len(m) > 1 {
			return strings.ToLower(m[1])
		}
	}
	if path != "" {
		ext := strings.TrimPrefix(filepath.Ext(path), ".")
		if len(ext) >= 2 && len(ext) <= 5 {
			return strings.ToLower(ext)
		}
	}
	return ""
}

func DownloadBookToFile(md5, title, expectedExt, outputDir string) (string, error) {
	if outputDir == "" {
		outputDir = "./downloads"
	}
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return "", err
	}

	downloadURL, err := ResolveDownloadLink(md5)
	if err != nil {
		return "", err
	}

	logDebug("Probing download endpoint: %s", downloadURL)
	probe, err := probeDownloadURL(downloadURL)
	if err != nil {
		logDebug("Probe failed (%v), falling back to direct stream", err)
		probe = &DownloadProbe{AcceptRanges: false, RedirectURL: downloadURL}
	}

	expectedClean := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(expectedExt), "."))
	if expectedClean != "" && probe.RealExtension != "" {
		if !strings.EqualFold(expectedClean, probe.RealExtension) {
			return "", fmt.Errorf("format mismatch: requested '%s', but this book item is actually in '%s' format",
				expectedClean, probe.RealExtension)
		}
	}

	finalExt := probe.RealExtension
	if finalExt == "" {
		finalExt = expectedClean
	}
	if finalExt == "" {
		finalExt = "pdf"
	}

	safeTitle := sanitizeFilename(title)
	if safeTitle == "" {
		safeTitle = md5
	}
	fileName := fmt.Sprintf("%s.%s", safeTitle, finalExt)
	finalPath := filepath.Join(outputDir, fileName)
	tempPath := finalPath + ".part"

	targetURL := probe.RedirectURL
	if targetURL == "" {
		targetURL = downloadURL
	}

	conns := Config.Connections
	if !probe.AcceptRanges || probe.ContentLength < 3*1024*1024 || conns <= 1 {
		logDebug("Downloading via stream (Range: %v, Size: %d)...", probe.AcceptRanges, probe.ContentLength)
		err = downloadResumableStream(targetURL, tempPath, finalPath, probe.ContentLength, probe.AcceptRanges)
	} else {
		logDebug("Range accelerated download with %d connections (Size: %.2f MB)...",
			conns, float64(probe.ContentLength)/(1024*1024))
		err = downloadMultiChunk(targetURL, tempPath, finalPath, probe.ContentLength, conns)
		if err != nil {
			logDebug("Multi-chunk encountered mirror limit/error (%v), falling back to resumable stream...", err)
			err = downloadResumableStream(targetURL, tempPath, finalPath, probe.ContentLength, probe.AcceptRanges)
		}
	}

	if err != nil {
		return "", err
	}

	return finalPath, nil
}

func downloadResumableStream(url, tempPath, finalPath string, totalSize int64, acceptRanges bool) error {
	var downloadedBytes int64 = 0

	if fi, err := os.Stat(tempPath); err == nil && acceptRanges {
		downloadedBytes = fi.Size()
		if totalSize > 0 && downloadedBytes == totalSize {
			return os.Rename(tempPath, finalPath)
		}
	}

	for attempt := 1; attempt <= Config.MaxRetries; attempt++ {
		client := getHTTPClient(180 * time.Second)
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return err
		}
		setCommonHeaders(req)

		flags := os.O_CREATE | os.O_WRONLY
		if downloadedBytes > 0 && acceptRanges {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", downloadedBytes))
			flags |= os.O_APPEND
			logDebug("[Stream] Resuming download from offset %d / %d (Attempt %d)...", downloadedBytes, totalSize, attempt)
		} else {
			flags |= os.O_TRUNC
			downloadedBytes = 0
		}

		resp, err := client.Do(req)
		if err != nil {
			logDebug("[Stream] Connection jitter (%v). Retrying in 2s...", err)
			time.Sleep(2 * time.Second)
			continue
		}

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			resp.Body.Close()
			if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
				downloadedBytes = 0
			}
			logDebug("[Stream] HTTP status %d. Retrying...", resp.StatusCode)
			time.Sleep(2 * time.Second)
			continue
		}

		out, err := os.OpenFile(tempPath, flags, 0644)
		if err != nil {
			resp.Body.Close()
			return err
		}

		buf := make([]byte, 64*1024)
		var readErr error
		for {
			n, rErr := resp.Body.Read(buf)
			if n > 0 {
				_, wErr := out.Write(buf[:n])
				if wErr != nil {
					readErr = wErr
					break
				}
				downloadedBytes += int64(n)
			}
			if rErr != nil {
				readErr = rErr
				break
			}
		}

		out.Close()
		resp.Body.Close()

		if readErr == io.EOF || (totalSize > 0 && downloadedBytes >= totalSize) {
			return os.Rename(tempPath, finalPath)
		}

		logDebug("[Stream] Stream interrupted: %v. Current progress: %d bytes. Reconnecting...", readErr, downloadedBytes)
		time.Sleep(1 * time.Second)
	}

	return fmt.Errorf("download interrupted after %d attempts (saved %d bytes)", Config.MaxRetries, downloadedBytes)
}

func downloadMultiChunk(url, tempPath, finalPath string, totalSize int64, numChunks int) error {
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return err
	}
	defer file.Close()

	if err := file.Truncate(totalSize); err != nil {
		return fmt.Errorf("failed to pre-allocate file size: %w", err)
	}

	chunkSize := totalSize / int64(numChunks)
	var wg sync.WaitGroup
	var downloadErr error
	var errMu sync.Mutex
	var totalDownloaded atomic.Int64

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for i := 0; i < numChunks; i++ {
		start := int64(i) * chunkSize
		end := start + chunkSize - 1
		if i == numChunks-1 {
			end = totalSize - 1
		}

		if i > 0 {
			time.Sleep(150 * time.Millisecond)
		}

		wg.Add(1)
		go func(chunkID int, startByte, endByte int64) {
			defer wg.Done()

			expectedBytes := endByte - startByte + 1
			var chunkSuccess bool

			for attempt := 1; attempt <= Config.MaxRetries; attempt++ {
				select {
				case <-ctx.Done():
					return
				default:
				}

				err := func() error {
					req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
					if err != nil {
						return err
					}
					setCommonHeaders(req)
					req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", startByte, endByte))

					client := getHTTPClient(90 * time.Second)
					resp, err := client.Do(req)
					if err != nil {
						return err
					}
					defer resp.Body.Close()

					if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
						return fmt.Errorf("HTTP status %d", resp.StatusCode)
					}

					buf := make([]byte, 32*1024)
					currentOffset := startByte
					var written int64

					for {
						n, readErr := resp.Body.Read(buf)
						if n > 0 {
							_, writeErr := file.WriteAt(buf[:n], currentOffset)
							if writeErr != nil {
								return writeErr
							}
							currentOffset += int64(n)
							written += int64(n)
							totalDownloaded.Add(int64(n))
						}
						if readErr != nil {
							if readErr == io.EOF {
								break
							}
							return readErr
						}
					}

					if written != expectedBytes {
						return fmt.Errorf("incomplete chunk: wrote %d / %d bytes", written, expectedBytes)
					}
					return nil
				}()

				if err == nil {
					chunkSuccess = true
					break
				}

				sleepDuration := time.Duration(attempt*attempt) * 500 * time.Millisecond
				logDebug("[Chunk %d] Attempt %d failed: %v. Backoff %v...", chunkID, attempt, err, sleepDuration)
				time.Sleep(sleepDuration)
			}

			if !chunkSuccess {
				errMu.Lock()
				if downloadErr == nil {
					downloadErr = fmt.Errorf("chunk %d failed after %d retries", chunkID, Config.MaxRetries)
					cancel()
				}
				errMu.Unlock()
			}
		}(i, start, end)
	}

	wg.Wait()

	if downloadErr != nil {
		return downloadErr
	}

	file.Close()
	return os.Rename(tempPath, finalPath)
}

// ==========================================
// UTILITIES
// ==========================================

func cleanHTML(s string) string {
	s = reHtmlTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.Join(strings.Fields(s), " ")
}

func sanitizeFilename(s string) string {
	s = reSanitize.ReplaceAllString(s, "_")
	s = strings.TrimSpace(s)
	if len(s) > 100 {
		s = s[:100]
	}
	return s
}

// ==========================================
// CLI, MCP SERVER & VCP STDIO PROTOCOL
// ==========================================

type VCPRequest struct {
	Command        string `json:"command"`
	Action         string `json:"action"`
	Query          string `json:"query"`
	Title          string `json:"title"`
	Format         string `json:"format"`
	SearchField    string `json:"searchField"`
	Field          string `json:"field"`
	Count          any    `json:"count"`
	MD5            string `json:"md5"`
	ExpectedFormat string `json:"expectedFormat"`
	OutputDir      string `json:"outputDir"`
}

func printVCPSuccess(text string) {
	resp := map[string]any{
		"status": "success",
		"result": map[string]any{
			"content": []map[string]any{
				{
					"type": "text",
					"text": text,
				},
			},
		},
	}
	bytes, _ := json.Marshal(resp)
	fmt.Println(string(bytes))
}

func printVCPError(errMsg string) {
	resp := map[string]any{
		"status": "error",
		"error":  errMsg,
	}
	bytes, _ := json.Marshal(resp)
	fmt.Println(string(bytes))
}

func handleVCPToolCall(rawInput []byte) bool {
	var vcpReq VCPRequest
	if err := json.Unmarshal(rawInput, &vcpReq); err != nil {
		return false
	}

	cmd := strings.TrimSpace(vcpReq.Command)
	if cmd == "" {
		cmd = strings.TrimSpace(vcpReq.Action)
	}

	// 识别搜索字段
	field := strings.TrimSpace(vcpReq.SearchField)
	if field == "" {
		field = strings.TrimSpace(vcpReq.Field)
	}
	if field == "" {
		field = "def"
	}

	// 数量解析
	count := 10
	if vcpReq.Count != nil {
		switch c := vcpReq.Count.(type) {
		case float64:
			if c > 0 {
				count = int(c)
			}
		case string:
			if parsed, err := strconv.Atoi(c); err == nil && parsed > 0 {
				count = parsed
			}
		}
	}

	outDir := strings.TrimSpace(vcpReq.OutputDir)
	if outDir == "" {
		outDir = "./downloads"
	}

	targetFormat := strings.ToLower(strings.TrimSpace(vcpReq.Format))
	if targetFormat == "" {
		targetFormat = strings.ToLower(strings.TrimSpace(vcpReq.ExpectedFormat))
	}

	// 统一处理3个主要动作：
	// 1. SearchBooks（目录检索与格式探测）
	// 2. DownloadBook（直接搜索+下载，或按书名下载）
	// 3. DownloadByMD5 / download_book（底层MD5精准下载）
	// 若无明确 command，则根据参数特征智能路由
	if cmd == "SearchBooks" || cmd == "search_books" || (cmd == "" && vcpReq.Query != "" && vcpReq.MD5 == "" && vcpReq.Title == "") {
		query := strings.TrimSpace(vcpReq.Query)
		if query == "" {
			query = strings.TrimSpace(vcpReq.Title)
		}
		if query == "" {
			printVCPError("参数缺少 query（搜索词）")
			return true
		}

		resp, err := SearchBooks(query, targetFormat, field, count)
		if err != nil {
			printVCPError(fmt.Sprintf("搜索图书失败: %v", err))
			return true
		}

		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("## 📚 图书检索结果（关键词：%s，模式：%s）\n\n", query, field))
		sb.WriteString(fmt.Sprintf("%s\n\n", resp.Notice))
		if len(resp.GlobalFormats) > 0 {
			sb.WriteString(fmt.Sprintf("- **全局可用格式列表**：`%s`\n", strings.Join(resp.GlobalFormats, ", ")))
		}
		sb.WriteString(fmt.Sprintf("- **去重实体书总数**：共 %d 本\n\n", resp.TotalUniqueBooks))

		if len(resp.Books) == 0 {
			sb.WriteString("⚠️ 未找到匹配的图书记录。建议检查书名、尝试作者搜索，或更换搜索字段。")
		} else {
			sb.WriteString("| 序号 | 书名 | 作者 | 年份 | 可用格式 | 推荐最佳MD5 |\n")
			sb.WriteString("| :--- | :--- | :--- | :--- | :--- | :--- |\n")
			for i, b := range resp.Books {
				sb.WriteString(fmt.Sprintf("| %d | **%s** | %s | %s | `%s` | `%s` |\n",
					i+1, b.Title, b.Author, b.Year, strings.Join(b.AvailableFormats, ", "), b.BestMD5))
			}
			sb.WriteString("\n> 💡 **下载指引**：选择您需要的书名与格式，使用 `DownloadBook` 指令即可一键下载；或使用 `DownloadByMD5` 指定上述 MD5 下载。")
		}

		printVCPSuccess(sb.String())
		return true
	}

	if cmd == "DownloadBook" || cmd == "download_book_by_title" || cmd == "smart_fetch_book" || (cmd == "" && (vcpReq.Title != "" || (vcpReq.Query != "" && targetFormat != ""))) {
		bookTitle := strings.TrimSpace(vcpReq.Title)
		if bookTitle == "" {
			bookTitle = strings.TrimSpace(vcpReq.Query)
		}
		if bookTitle == "" {
			printVCPError("参数缺少 title 或 query（书籍名称）")
			return true
		}

		if targetFormat == "" {
			targetFormat = "epub"
		}

		if field == "def" {
			field = "title"
		}

		resp, err := DownloadDirectBook(bookTitle, targetFormat, field, outDir)
		if err != nil {
			printVCPError(fmt.Sprintf("下载图书失败: %v", err))
			return true
		}

		var sb strings.Builder
		sb.WriteString("## ✅ 图书高速下载成功！\n\n")
		sb.WriteString(fmt.Sprintf("- **书名**：%s\n", resp.SelectedBook.Title))
		sb.WriteString(fmt.Sprintf("- **作者**：%s\n", resp.SelectedBook.Author))
		sb.WriteString(fmt.Sprintf("- **文件格式**：`%s`\n", resp.SelectedBook.BestFormat))
		sb.WriteString(fmt.Sprintf("- **本地落盘路径**：`%s`\n", resp.FilePath))
		sb.WriteString(fmt.Sprintf("- **MD5 校验值**：`%s`\n", resp.SelectedBook.BestMD5))
		sb.WriteString("\n文件已完整保存到服务器本地，可直接提供给用户或供后续阅读器读取。")

		printVCPSuccess(sb.String())
		return true
	}

	if cmd == "DownloadByMD5" || cmd == "download_book" || (cmd == "" && vcpReq.MD5 != "") {
		md5 := strings.TrimSpace(vcpReq.MD5)
		if md5 == "" {
			printVCPError("参数缺少 md5")
			return true
		}

		title := strings.TrimSpace(vcpReq.Title)
		if title == "" {
			title = "book_" + md5
		}

		filePath, err := DownloadBookToFile(md5, title, targetFormat, outDir)
		if err != nil {
			printVCPError(fmt.Sprintf("按 MD5 下载图书失败: %v", err))
			return true
		}

		var sb strings.Builder
		sb.WriteString("## ✅ 图书按 MD5 下载成功！\n\n")
		sb.WriteString(fmt.Sprintf("- **MD5**：`%s`\n", md5))
		sb.WriteString(fmt.Sprintf("- **本地落盘路径**：`%s`\n", filePath))
		sb.WriteString("\n文件已完成断点校验并原子落盘。")

		printVCPSuccess(sb.String())
		return true
	}

	return false
}

func main() {
	initConfig()

	if len(os.Args) > 1 {
		cmd := os.Args[1]
		switch cmd {
		case "search":
			if len(os.Args) < 3 {
				fmt.Println("Usage: LdBook search <query> [format] [field: def|title|author|isbn] [count]")
				return
			}
			query := os.Args[2]
			format := ""
			field := "def"
			count := 5

			for i := 3; i < len(os.Args); i++ {
				arg := os.Args[i]
				if c, err := strconv.Atoi(arg); err == nil {
					count = c
				} else if arg == "def" || arg == "title" || arg == "author" || arg == "isbn" {
					field = arg
				} else if format == "" {
					format = arg
				}
			}

			start := time.Now()
			fmt.Printf("Searching for '%s' (format: '%s', field: %s)...\n", query, format, field)
			resp, err := SearchBooks(query, format, field, count)
			if err != nil {
				fmt.Printf("Search failed: %v\n", err)
				return
			}

			fmt.Printf("Completed in %v!\nNotice: %s\n\n", time.Since(start), resp.Notice)
			for i, b := range resp.Books {
				fmt.Printf("[%d] %s (%s)\n    Author: %s | Formats Available: [%s] | Size: %s | Best MD5: %s\n\n",
					i+1, b.Title, b.Year, b.Author, strings.Join(b.AvailableFormats, ", "), b.Size, b.BestMD5)
			}

		case "fetch":
			if len(os.Args) < 3 {
				fmt.Println("Usage: LdBook fetch <query> [format] [field] [outputDir]")
				return
			}
			query := os.Args[2]
			format := ""
			field := "def"
			outDir := "./downloads"

			for i := 3; i < len(os.Args); i++ {
				arg := os.Args[i]
				if arg == "def" || arg == "title" || arg == "author" || arg == "isbn" {
					field = arg
				} else if strings.HasPrefix(arg, "./") || strings.HasPrefix(arg, "/") || strings.Contains(arg, "\\") {
					outDir = arg
				} else if format == "" {
					format = arg
				}
			}

			start := time.Now()
			fmt.Printf("Executing Smart Fetch for '%s' (format: '%s', field: '%s')...\n", query, format, field)
			resp, err := SmartFetchBook(query, format, field, outDir)
			if err != nil {
				fmt.Printf("Fetch error: %v\n", err)
				return
			}

			fmt.Printf("Status: %s (took %v)\nMessage: %s\n", resp.Status, time.Since(start), resp.Message)
			if resp.Status == "downloaded" {
				fmt.Printf("File saved at: %s\n", resp.FilePath)
			} else if resp.Status == "multiple_choices" {
				fmt.Println("\nUnique books available for selection:")
				for i, b := range resp.AvailableBooks {
					fmt.Printf("[%d] %s (%s)\n    Author: %s | Supported Formats: [%s] | MD5: %s\n\n",
						i+1, b.Title, b.Year, b.Author, strings.Join(b.AvailableFormats, ", "), b.BestMD5)
				}
			}

		case "download":
			if len(os.Args) < 3 {
				fmt.Println("Usage: LdBook download <query_or_md5> [format] [field] [outputDir]")
				return
			}
			target := os.Args[2]
			format := "epub"
			field := "title"
			outDir := "./downloads"

			if len(os.Args) >= 4 {
				format = os.Args[3]
			}
			if len(os.Args) >= 5 {
				field = os.Args[4]
			}
			if len(os.Args) >= 6 {
				outDir = os.Args[5]
			}

			start := time.Now()
			if len(target) == 32 && isHex(target) {
				fmt.Printf("Downloading MD5 %s to %s ...\n", target, outDir)
				path, err := DownloadBookToFile(target, "book_"+target, format, outDir)
				if err != nil {
					fmt.Printf("Download error: %v\n", err)
					return
				}
				fmt.Printf("Success! File saved at: %s (took %v)\n", path, time.Since(start))
			} else {
				fmt.Printf("Directly downloading book '%s' (format: %s) to %s ...\n", target, format, outDir)
				resp, err := DownloadDirectBook(target, format, field, outDir)
				if err != nil {
					fmt.Printf("Download error: %v\n", err)
					return
				}
				fmt.Printf("Success! File saved at: %s (took %v)\n", resp.FilePath, time.Since(start))
			}

		default:
			fmt.Println("Unknown command.")
		}
		return
	}

	RunMCPServer()
}

func isHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func RunMCPServer() {
	// 首先尝试读入第一行，判断是 VCP JSON 格式还是 MCP JSON-RPC 2.0 格式
	reader := bufio.NewReader(os.Stdin)
	for {
		lineBytes, err := reader.ReadBytes('\n')
		if len(lineBytes) == 0 && err != nil {
			break
		}

		line := strings.TrimSpace(string(lineBytes))
		if line == "" {
			if err != nil {
				break
			}
			continue
		}

		// 尝试优先以 VCP 同步协议解析
		if handleVCPToolCall([]byte(line)) {
			// VCP 同步调用一次输入对应一次退出
			return
		}

		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      any             `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}

		switch req.Method {
		case "initialize":
			resp, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"protocolVersion": "2024-11-05",
					"capabilities":    map[string]any{"tools": map[string]any{}},
					"serverInfo":       map[string]any{"name": "LdBook", "version": "2.4.0"},
				},
			})
			fmt.Println(string(resp))

		case "tools/list":
			resp, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"tools": []map[string]any{
						{
							"name":        "search_books",
							"description": "Search LibGen with title-aggregation (each entry is an individual book showing all available formats and author) and relevance ranking.",
							"inputSchema": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"query":       map[string]any{"type": "string", "description": "Title, author, keyword, or ISBN"},
									"format":      map[string]any{"type": "string", "description": "Desired file format filter (e.g. 'txt', 'epub', 'pdf', 'mobi')."},
									"searchField": map[string]any{"type": "string", "enum": []string{"def", "title", "author", "isbn"}, "description": "Search field (default: def)"},
									"count":       map[string]any{"type": "number", "description": "Max distinct books to return (default: 10)"},
								},
								"required": []string{"query"},
							},
						},
						{
							"name":        "download_book_by_title",
							"description": "Directly download a book by precise title and format in ONE step without having to search or choose an MD5. Automatically resolves the top ranked match and downloads it directly to disk.",
							"inputSchema": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"title":       map[string]any{"type": "string", "description": "Exact or clear book title to download (e.g. '三体 Ⅲ', 'Effective Java')"},
									"format":      map[string]any{"type": "string", "description": "File format (e.g. 'epub', 'pdf', 'mobi', 'txt'). If omitted, defaults to 'epub'."},
									"searchField": map[string]any{"type": "string", "enum": []string{"title", "def", "author", "isbn"}, "description": "Search field constraint (default: title)"},
									"outputDir":   map[string]any{"type": "string", "description": "Destination directory (default: ./downloads)"},
								},
								"required": []string{"title"},
							},
						},
						{
							"name":        "smart_fetch_book",
							"description": "Two-stage intelligent book acquisition: If query + format is unambiguous (single clear title), directly downloads it in one shot. If query is broad (author search, series, or multi-volumes like '三体'), returns the catalog with all supported formats so AI can choose the exact item to download.",
							"inputSchema": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"query":       map[string]any{"type": "string", "description": "Book title, author, keyword, or ISBN"},
									"format":      map[string]any{"type": "string", "description": "Desired file format (e.g. 'epub', 'pdf', 'txt')"},
									"searchField": map[string]any{"type": "string", "enum": []string{"def", "title", "author", "isbn"}, "description": "Search field (default: def)"},
									"outputDir":   map[string]any{"type": "string", "description": "Destination directory (default: ./downloads)"},
								},
								"required": []string{"query"},
							},
						},
						{
							"name":        "download_book",
							"description": "High-speed resumable book download with strict format checking by MD5 hash.",
							"inputSchema": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"md5":            map[string]any{"type": "string", "description": "Book MD5 hash"},
									"expectedFormat": map[string]any{"type": "string", "description": "Strict expected file format (e.g. 'txt', 'epub', 'pdf'). If the actual book format differs, download will safely fail."},
									"title":          map[string]any{"type": "string", "description": "Book title for filename"},
									"outputDir":      map[string]any{"type": "string", "description": "Destination directory (default: ./downloads)"},
								},
								"required": []string{"md5"},
							},
						},
					},
				},
			})
			fmt.Println(string(resp))

		case "tools/call":
			var callParams struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			json.Unmarshal(req.Params, &callParams)

			if callParams.Name == "search_books" {
				query, _ := callParams.Arguments["query"].(string)
				format, _ := callParams.Arguments["format"].(string)
				searchField, _ := callParams.Arguments["searchField"].(string)
				if searchField == "" {
					searchField = "def"
				}
				count := 10
				if c, ok := callParams.Arguments["count"].(float64); ok && c > 0 {
					count = int(c)
				}

				searchResp, err := SearchBooks(query, format, searchField, count)
				if err != nil {
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"isError": true,
							"content": []map[string]any{{"type": "text", "text": fmt.Sprintf("Search error: %v", err)}},
						},
					})
					fmt.Println(string(resp))
				} else {
					jsonBytes, _ := json.MarshalIndent(searchResp, "", "  ")
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"content": []map[string]any{{"type": "text", "text": string(jsonBytes)}},
						},
					})
					fmt.Println(string(resp))
				}

			} else if callParams.Name == "download_book_by_title" {
				title, _ := callParams.Arguments["title"].(string)
				format, _ := callParams.Arguments["format"].(string)
				searchField, _ := callParams.Arguments["searchField"].(string)
				if searchField == "" {
					searchField = "title"
				}
				outDir, _ := callParams.Arguments["outputDir"].(string)

				fetchResp, err := DownloadDirectBook(title, format, searchField, outDir)
				if err != nil {
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"isError": true,
							"content": []map[string]any{{"type": "text", "text": fmt.Sprintf("Direct download error: %v", err)}},
						},
					})
					fmt.Println(string(resp))
				} else {
					jsonBytes, _ := json.MarshalIndent(fetchResp, "", "  ")
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"content": []map[string]any{{"type": "text", "text": string(jsonBytes)}},
						},
					})
					fmt.Println(string(resp))
				}

			} else if callParams.Name == "smart_fetch_book" {
				query, _ := callParams.Arguments["query"].(string)
				format, _ := callParams.Arguments["format"].(string)
				searchField, _ := callParams.Arguments["searchField"].(string)
				if searchField == "" {
					searchField = "def"
				}
				outDir, _ := callParams.Arguments["outputDir"].(string)

				fetchResp, err := SmartFetchBook(query, format, searchField, outDir)
				if err != nil {
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"isError": true,
							"content": []map[string]any{{"type": "text", "text": fmt.Sprintf("Fetch failed: %v", err)}},
						},
					})
					fmt.Println(string(resp))
				} else {
					jsonBytes, _ := json.MarshalIndent(fetchResp, "", "  ")
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"content": []map[string]any{{"type": "text", "text": string(jsonBytes)}},
						},
					})
					fmt.Println(string(resp))
				}

			} else if callParams.Name == "download_book" {
				md5, _ := callParams.Arguments["md5"].(string)
				expectedFormat, _ := callParams.Arguments["expectedFormat"].(string)
				title, _ := callParams.Arguments["title"].(string)
				outDir, _ := callParams.Arguments["outputDir"].(string)

				filePath, err := DownloadBookToFile(md5, title, expectedFormat, outDir)
				if err != nil {
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"isError": true,
							"content": []map[string]any{{"type": "text", "text": fmt.Sprintf("Download refused/failed: %v", err)}},
						},
					})
					fmt.Println(string(resp))
				} else {
					resp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result": map[string]any{
							"content": []map[string]any{{"type": "text", "text": fmt.Sprintf("Downloaded successfully to: %s", filePath)}},
						},
					})
					fmt.Println(string(resp))
				}
			}
		}
	}
}
