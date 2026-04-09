export function resolveSunoApiModel(mv) {
    switch (mv) {
        case 'chirp-v3-0':
            return 'V4';
        case 'chirp-v3-5':
            return 'V4_5';
        case 'chirp-v4':
        case 'chirp-v4-5':
        default:
            return 'V4_5ALL';
    }
}

function cleanObject(input) {
    const output = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && value !== '') {
            output[key] = value;
        }
    }
    return output;
}

export function buildSunoApiRequest(args, callBackUrl) {
    if (!callBackUrl || typeof callBackUrl !== 'string') {
        throw new Error('SunoCallbackUrl environment variable is required for docs.sunoapi.org integration.');
    }

    const model = resolveSunoApiModel(args.mv);

    if (args.task_id && args.continue_at !== undefined && args.continue_clip_id) {
        const hasCustomExtensionPrompt = typeof args.prompt === 'string' && args.prompt.trim() !== '';
        if (hasCustomExtensionPrompt) {
            if (!args.tags || !args.title) {
                throw new Error("Continuation mode with custom prompt requires 'tags' and 'title' to map to SunoAPI extend custom parameters.");
            }
            return {
                endpoint: '/api/v1/generate/extend',
                payload: cleanObject({
                    defaultParamFlag: true,
                    audioId: args.continue_clip_id,
                    continueAt: args.continue_at,
                    prompt: args.prompt,
                    style: args.tags,
                    title: args.title,
                    model,
                    callBackUrl
                })
            };
        }

        return {
            endpoint: '/api/v1/generate/extend',
            payload: cleanObject({
                defaultParamFlag: false,
                audioId: args.continue_clip_id,
                model,
                callBackUrl
            })
        };
    }

    if (typeof args.gpt_description_prompt === 'string' && args.gpt_description_prompt.trim() !== '') {
        return {
            endpoint: '/api/v1/generate',
            payload: cleanObject({
                customMode: false,
                instrumental: Boolean(args.make_instrumental),
                model,
                callBackUrl,
                prompt: args.gpt_description_prompt
            })
        };
    }

    return {
        endpoint: '/api/v1/generate',
        payload: cleanObject({
            customMode: true,
            instrumental: Boolean(args.make_instrumental),
            model,
            callBackUrl,
            prompt: args.prompt,
            style: args.tags,
            title: args.title
        })
    };
}

export function extractTaskId(submitResponseData) {
    const taskId = submitResponseData?.data?.taskId;
    if (submitResponseData?.code !== 200 || typeof taskId !== 'string' || taskId.trim() === '') {
        throw new Error(`Suno API submission failed: ${submitResponseData?.msg || 'No taskId returned or unexpected response structure.'} (Raw: ${JSON.stringify(submitResponseData)})`);
    }
    return taskId.trim();
}

export function getTaskStatusInfo(recordResponseData) {
    const data = recordResponseData?.data;
    if (recordResponseData?.code !== 200 || !data) {
        throw new Error(`Suno task query failed: ${recordResponseData?.msg || 'No data from API.'}`);
    }

    return {
        taskId: data.taskId,
        status: data.status,
        errorMessage: data.errorMessage || null
    };
}

export function extractTrackFromRecordInfo(recordResponseData) {
    const data = recordResponseData?.data;
    const response = data?.response;
    const track =
        response?.data?.[0] ||
        response?.sunoData?.[0] ||
        null;

    if (!track) {
        return null;
    }

    return {
        id: track.id,
        audioUrl: track.audio_url || track.audioUrl || null,
        title: track.title || null,
        tags: track.tags || null,
        imageUrl: track.image_url || track.imageUrl || null
    };
}
