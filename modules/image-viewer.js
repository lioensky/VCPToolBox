document.addEventListener('DOMContentLoaded', async () => {
    const imgElement = document.getElementById('viewerImage');
    const errorDiv = document.getElementById('errorMessage');
    const imageControls = document.getElementById('imageControls');
    const copyButton = document.getElementById('copyButton');
    const downloadButton = document.getElementById('downloadButton');

    let currentScale = 1;
    const minScale = 0.2;
    const maxScale = 5;
    let isDragging = false;
    let startX, startY;
    let imgInitialX = 0; // To store image's current translation
    let imgInitialY = 0;

    // Theme Management
    function applyTheme(theme) {
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    const params = new URLSearchParams(window.location.search);
    const imageUrl = params.get('src');
    const imageTitle = params.get('title') || '图片预览';
    const initialTheme = params.get('theme') || 'dark';

    // Apply initial theme immediately
    applyTheme(initialTheme);
    console.log(`Image Viewer: Initial theme set from URL: ${initialTheme}`);

    // Listen for subsequent theme updates
    if (window.electronAPI) {
        window.electronAPI.onThemeUpdated(applyTheme);
    } else {
        console.log('Image Viewer: electronAPI not found. Theme updates will not be received.');
    }
    const decodedTitle = decodeURIComponent(imageTitle);
    
    document.title = decodedTitle;
    document.getElementById('image-title-text').textContent = decodedTitle;
 
     if (imageUrl) {
         const decodedImageUrl = decodeURIComponent(imageUrl);
        console.log('Image Viewer: Loading image -', decodedImageUrl);
        imgElement.src = decodedImageUrl;
        imgElement.alt = decodeURIComponent(imageTitle);

        imgElement.onload = () => {
            console.log('Image Viewer: Image loaded successfully.');
            imgElement.style.display = 'block';
            imageControls.style.display = 'flex'; // Set display so it can become visible
            errorDiv.style.display = 'none';

            // Add hover listeners for showing/hiding controls
            imgElement.addEventListener('mouseenter', () => {
                imageControls.classList.add('active');
            });
            imgElement.addEventListener('mouseleave', () => {
                // Check if mouse is over the controls themselves before hiding
                setTimeout(() => { // Timeout to allow moving to controls
                    if (!imageControls.matches(':hover')) {
                        imageControls.classList.remove('active');
                    }
                }, 50); // Small delay
            });
            // Keep controls visible if mouse moves onto them
            imageControls.addEventListener('mouseenter', () => {
                imageControls.classList.add('active');
            });
            imageControls.addEventListener('mouseleave', () => {
                imageControls.classList.remove('active');
            });

            // Zoom functionality
            imgElement.addEventListener('wheel', (event) => {
                if (event.ctrlKey) {
                    event.preventDefault(); // Prevent page zoom

                    const mouseX = event.offsetX; // Mouse X relative to image's padding edge
                    const mouseY = event.offsetY;  // Mouse Y relative to image's padding edge

                    const scaleAmount = 0.1;
                    const oldScale = currentScale;

                    let newScale;
                    if (event.deltaY < 0) { // Zoom in
                        newScale = Math.min(maxScale, oldScale + scaleAmount);
                    } else { // Zoom out
                        newScale = Math.max(minScale, oldScale - scaleAmount);
                    }

                    if (newScale === oldScale) {
                        return; // No change, no need to update
                    }

                    // Adjust translation to zoom around the mouse pointer
                    imgInitialX = mouseX - ((mouseX - imgInitialX) / oldScale) * newScale;
                    imgInitialY = mouseY - ((mouseY - imgInitialY) / oldScale) * newScale;
                    
                    currentScale = newScale;

                    // Apply new transform
                    imgElement.style.transform = `translate(${imgInitialX}px, ${imgInitialY}px) scale(${currentScale})`;

                    if (currentScale > 1) {
                        imgElement.style.cursor = 'grab';
                    } else {
                        imgElement.style.cursor = 'default';
                        // Reset translation if scaled back to 1 or less
                        imgInitialX = 0;
                        imgInitialY = 0;
                        imgElement.style.transform = `translate(0px, 0px) scale(${currentScale})`;
                    }
                }
            }, { passive: false }); // passive: false to allow preventDefault

            // Drag functionality
            imgElement.addEventListener('mousedown', (event) => {
                if (event.button === 0 && currentScale > 1) { // Only on left click and when zoomed
                    isDragging = true;
                    startX = event.clientX;
                    startY = event.clientY;
                    imgElement.style.cursor = 'grabbing';
                    event.preventDefault();
                }
            });

            document.addEventListener('mousemove', (event) => {
                if (isDragging) {
                    const dx = event.clientX - startX;
                    const dy = event.clientY - startY;
                    
                    const newTranslateX = imgInitialX + dx;
                    const newTranslateY = imgInitialY + dy;
                    
                    imgElement.style.transform = `translate(${newTranslateX}px, ${newTranslateY}px) scale(${currentScale})`;
                }
            });

            document.addEventListener('mouseup', (event) => {
                if (event.button === 0 && isDragging) {
                    isDragging = false;
                    if (currentScale > 1) {
                        imgElement.style.cursor = 'grab';
                    } else {
                        imgElement.style.cursor = 'default';
                    }
                    // Persist the new translation
                    const currentTransform = new WebKitCSSMatrix(window.getComputedStyle(imgElement).transform);
                    imgInitialX = currentTransform.m41;
                    imgInitialY = currentTransform.m42;
                }
            });
             // Also stop dragging if mouse leaves the window
            document.addEventListener('mouseleave', () => {
               if (isDragging) {
                   isDragging = false;
                   if (currentScale > 1) {
                       imgElement.style.cursor = 'grab';
                   } else {
                       imgElement.style.cursor = 'default';
                   }
                   const currentTransform = new WebKitCSSMatrix(window.getComputedStyle(imgElement).transform);
                   imgInitialX = currentTransform.m41;
                   imgInitialY = currentTransform.m42;
               }
           });

        };
        imgElement.onerror = () => {
            console.error('Image Viewer: Error loading image -', decodedImageUrl);
            imgElement.style.display = 'none';
            imageControls.style.display = 'none';
            errorDiv.textContent = `无法加载图片: ${decodeURIComponent(imageTitle)}`;
            errorDiv.style.display = 'block';
        };

    } else {
        console.error('Image Viewer: No image URL provided.');
        imgElement.style.display = 'none';
        imageControls.style.display = 'none';
        errorDiv.textContent = '未提供图片URL。';
        errorDiv.style.display = 'block';
    }

    copyButton.addEventListener('click', async () => {
        if (!imgElement.src || imgElement.src === window.location.href) {
            console.warn('Image Viewer: No valid image to copy.');
            const originalText = copyButton.innerHTML;
            copyButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg> 无效图片';
            setTimeout(() => {
                copyButton.innerHTML = originalText;
            }, 2000);
            return;
        }
        const originalButtonText = copyButton.innerHTML;
        try {
            const response = await fetch(imgElement.src);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            let blob = await response.blob();
            let finalBlobType = blob.type || 'image/png';

            if (blob.type === 'image/jpeg' || blob.type === 'image/jpg') {
                console.log('Image Viewer: Converting JPEG to PNG for clipboard.');
                try {
                    const imageBitmap = await createImageBitmap(blob);
                    const canvas = document.createElement('canvas');
                    canvas.width = imageBitmap.width;
                    canvas.height = imageBitmap.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(imageBitmap, 0, 0);
                    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    finalBlobType = 'image/png';
                    console.log('Image Viewer: Conversion to PNG successful.');
                } catch (conversionError) {
                    console.error('Image Viewer: Failed to convert JPEG to PNG -', conversionError);
                }
            }

            const item = new ClipboardItem({ [finalBlobType]: blob });
            await navigator.clipboard.write([item]);
            console.log('Image copied to clipboard as', finalBlobType);
            copyButton.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px; height:18px; fill:currentColor;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg> 已复制';
            setTimeout(() => {
                copyButton.innerHTML = originalButtonText;
            }, 2000);
        } catch (err) {
            console.error('Image Viewer: Failed to copy image -', err);
            copyButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg> 复制失败';
             setTimeout(() => {
                copyButton.innerHTML = originalButtonText;
            }, 2000);
        }
    });

    downloadButton.addEventListener('click', () => {
        if (!imgElement.src || imgElement.src === window.location.href) {
            console.warn('Image Viewer: No valid image to download.');
            return;
        }
        try {
            const link = document.createElement('a');
            link.href = imgElement.src;
            
            let filename = decodeURIComponent(imageTitle) || 'downloaded_image';
            const urlFilename = imgElement.src.substring(imgElement.src.lastIndexOf('/') + 1).split('?')[0];
            const urlExtensionMatch = urlFilename.match(/\.(jpe?g|png|gif|webp|svg)$/i);
            const titleExtensionMatch = filename.match(/\.(jpe?g|png|gif|webp|svg)$/i);

            if (!titleExtensionMatch && urlExtensionMatch) {
                const baseFilename = filename.replace(/\.[^/.]+$/, "");
                if (baseFilename + urlExtensionMatch[0] !== filename) {
                   filename = baseFilename + urlExtensionMatch[0];
                } else if (!filename.endsWith(urlExtensionMatch[0])) {
                   filename += urlExtensionMatch[0];
                }
            } else if (!titleExtensionMatch && !urlExtensionMatch) {
                 if (!/\.[a-z0-9]{3,4}$/i.test(filename)) {
                    filename += '.png';
                 }
            }
            
            link.download = filename.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_');

            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            console.log('Image download initiated for:', link.download);
        } catch (err) {
            console.error('Image Viewer: Failed to initiate download -', err);
        }
    });

    // Add keyboard listener for Escape key to close the window
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            window.close();
        }
    });

   // --- Custom Title Bar Listeners ---
   const minimizeBtn = document.getElementById('minimize-viewer-btn');
   const maximizeBtn = document.getElementById('maximize-viewer-btn');
   const closeBtn = document.getElementById('close-viewer-btn');

   minimizeBtn.addEventListener('click', () => {
       if (window.electronAPI) window.electronAPI.minimizeWindow();
   });

   maximizeBtn.addEventListener('click', () => {
       if (window.electronAPI) window.electronAPI.maximizeWindow();
   });

   closeBtn.addEventListener('click', () => {
       window.close();
   });
});