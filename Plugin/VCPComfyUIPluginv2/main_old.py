import os
import json
import sys
import time
import glob
import uuid # For client_id if needed for ComfyUI API
# requests library will be needed for HTTP calls
# from PIL import Image and import base64 if returning base64 images

# --- Setup: Load .env file and Prepare Paths ---
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))

def load_env_file(filepath):
    """Loads a .env file into the environment variables."""
    if not os.path.isfile(filepath):
        return
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip()
                if key not in os.environ: # Only set if not already present in the environment
                    os.environ[key] = value

# Load config.env from the plugin directory
env_path = os.path.join(PLUGIN_DIR, 'config.env')
load_env_file(env_path)

# --- Configuration from Environment Variables ---
COMFYUI_BASE_URL = os.getenv("COMFYUI_BASE_URL", "http://127.0.0.1:8001").rstrip('/')
COMFYUI_WORKFLOWS_PATH_REL = os.getenv("COMFYUI_WORKFLOWS_PATH", "workflows")
COMFYUI_OUTPUT_IMAGE_TYPE = os.getenv("COMFYUI_OUTPUT_IMAGE_TYPE", "url").lower()
COMFYUI_REQUEST_TIMEOUT_SECONDS = int(os.getenv("COMFYUI_REQUEST_TIMEOUT_SECONDS", "120"))

# Resolve absolute path for workflows, assuming main.py is in VCPComfyUIPlugin/
COMFYUI_WORKFLOWS_PATH_ABS = os.path.join(PLUGIN_DIR, COMFYUI_WORKFLOWS_PATH_REL)

# --- Placeholder for HTTP client (to be imported later or defined) ---
# import requests # Make sure 'requests' is in your VCPToolBox global requirements.txt or plugin-specific one

# --- Logging (optional, but good for debugging) ---
def log_stderr(message):
    print(f"[VCPComfyUIPlugin] {message}", file=sys.stderr)
    sys.stderr.flush()

# --- Command Handlers ---

def handle_list_workflows(params):
    try:
        if not os.path.isdir(COMFYUI_WORKFLOWS_PATH_ABS):
            return {"status": "error", "error": f"Workflows directory not found: {COMFYUI_WORKFLOWS_PATH_ABS}"}
        
        workflow_files = []
        for filepath in glob.glob(os.path.join(COMFYUI_WORKFLOWS_PATH_ABS, '*.json')):
            workflow_files.append(os.path.basename(filepath))
            
        return {"status": "success", "result": json.dumps(workflow_files)}
    except Exception as e:
        log_stderr(f"Error in handle_list_workflows: {str(e)}")
        return {"status": "error", "error": f"Failed to list workflows: {str(e)}"}

def handle_discover_environment(params):
    try:
        # Ensure 'requests' is available (though top-level import attempt should handle this)
        try:
            import requests
        except ImportError:
            log_stderr("Critical: 'requests' library is not installed or accessible within handle_discover_environment.")
            return {"status": "error", "error": "The 'requests' library is not available. Please ensure it is installed in the VCPToolBox environment."}
        
        # Attempt to import traceback for detailed error logging if not already imported
        try:
            import traceback
        except ImportError:
            traceback = None # Fallback if traceback cannot be imported

        environment_data = {}
        object_info_url = f"{COMFYUI_BASE_URL}/object_info"
        try:
            log_stderr(f"Fetching object_info from: {object_info_url}") # Using log_stderr for consistency
            response = requests.get(object_info_url, timeout=45) # Increased timeout
            response.raise_for_status()
            full_object_info = response.json()
            environment_data["available_nodes"] = list(full_object_info.keys())
            
            # Checkpoints
            checkpoints_list = []
            loader_node_names = ["CheckpointLoaderSimple", "CheckpointLoader", "UltimateSDUpscale", "Efficient Loader"]
            for loader_name in loader_node_names:
                if loader_name in full_object_info:
                    node_info = full_object_info[loader_name]
                    if node_info.get("input", {}).get("required", {}).get("ckpt_name"):
                        ckpt_name_param = node_info["input"]["required"]["ckpt_name"]
                        # ckpt_name_param is expected to be a list like [["model1.safetensors", "model2.ckpt"], "Comfy.ModelType"]
                        if isinstance(ckpt_name_param, list) and len(ckpt_name_param) > 0 and isinstance(ckpt_name_param[0], list):
                            checkpoints_list.extend(ckpt_name_param[0])
                            log_stderr(f"Extracted {len(ckpt_name_param[0])} checkpoints from {loader_name}")
            environment_data["checkpoints"] = list(set(checkpoints_list))

            # Samplers
            samplers_list = []
            if "KSampler" in full_object_info:
                ksampler_info = full_object_info["KSampler"]
                if ksampler_info.get("input", {}).get("required", {}).get("sampler_name"):
                    sampler_name_param = ksampler_info["input"]["required"]["sampler_name"]
                    if isinstance(sampler_name_param, list) and len(sampler_name_param) > 0 and isinstance(sampler_name_param[0], list):
                        samplers_list.extend(sampler_name_param[0])
            if not samplers_list: # Fallback if KSampler parsing fails or KSampler not found
                try:
                    samplers_url = f"{COMFYUI_BASE_URL}/samplers"
                    log_stderr(f"Attempting to fetch samplers from fallback URL: {samplers_url}")
                    response_samplers = requests.get(samplers_url, timeout=10)
                    if response_samplers.status_code == 200:
                        samplers_list.extend(response_samplers.json())
                        log_stderr(f"Fetched {len(response_samplers.json())} samplers from {samplers_url}")
                    else:
                        log_stderr(f"/samplers endpoint returned {response_samplers.status_code}")
                except requests.exceptions.RequestException as e_samp:
                    log_stderr(f"Could not fetch /samplers: {str(e_samp)}")
            environment_data["samplers"] = list(set(samplers_list))

            # Schedulers
            schedulers_list = []
            if "KSampler" in full_object_info:
                ksampler_info = full_object_info["KSampler"]
                if ksampler_info.get("input", {}).get("required", {}).get("scheduler"):
                    scheduler_param = ksampler_info["input"]["required"]["scheduler"]
                    if isinstance(scheduler_param, list) and len(scheduler_param) > 0 and isinstance(scheduler_param[0], list):
                        schedulers_list.extend(scheduler_param[0])
            if not schedulers_list: # Fallback
                try:
                    schedulers_url = f"{COMFYUI_BASE_URL}/schedulers"
                    log_stderr(f"Attempting to fetch schedulers from fallback URL: {schedulers_url}")
                    response_schedulers = requests.get(schedulers_url, timeout=10)
                    if response_schedulers.status_code == 200:
                        schedulers_list.extend(response_schedulers.json())
                        log_stderr(f"Fetched {len(response_schedulers.json())} schedulers from {schedulers_url}")
                    else:
                        log_stderr(f"/schedulers endpoint returned {response_schedulers.status_code}")
                except requests.exceptions.RequestException as e_sch:
                    log_stderr(f"Could not fetch /schedulers: {str(e_sch)}")
            environment_data["schedulers"] = list(set(schedulers_list))

            # LoRAs
            loras_list = []
            if "LoraLoader" in full_object_info: # Common Lora Loader node name
                lora_loader_info = full_object_info["LoraLoader"]
                if lora_loader_info.get("input", {}).get("required", {}).get("lora_name"):
                    lora_name_param = lora_loader_info["input"]["required"]["lora_name"]
                    if isinstance(lora_name_param, list) and len(lora_name_param) > 0 and isinstance(lora_name_param[0], list):
                        loras_list.extend(lora_name_param[0])
            # Fallback for LoRAs if not found via LoraLoader or if LoraLoader has different structure
            if not loras_list:
                try:
                    loras_url = f"{COMFYUI_BASE_URL}/loras"
                    log_stderr(f"Attempting to fetch loras from fallback URL: {loras_url}")
                    response_loras = requests.get(loras_url, timeout=10)
                    if response_loras.status_code == 200:
                        loras_list.extend(response_loras.json())
                        log_stderr(f"Fetched {len(response_loras.json())} loras from {loras_url}")
                    else:
                        log_stderr(f"/loras endpoint returned {response_loras.status_code}")
                except requests.exceptions.RequestException as e_lora:
                    log_stderr(f"Could not fetch /loras: {str(e_lora)}")
            environment_data["loras"] = list(set(loras_list))
            
            # VAEs
            vaes_list = []
            if "VAELoader" in full_object_info:
                vae_loader_info = full_object_info["VAELoader"]
                if vae_loader_info.get("input", {}).get("required", {}).get("vae_name"):
                    vae_name_param = vae_loader_info["input"]["required"]["vae_name"]
                    if isinstance(vae_name_param, list) and len(vae_name_param) > 0 and isinstance(vae_name_param[0], list) and vae_name_param[0]:
                        vaes_list.extend(vae_name_param[0])
            # Fallback for VAEs
            if not vaes_list:
                try:
                    vaes_url = f"{COMFYUI_BASE_URL}/vae" # Common endpoint name
                    log_stderr(f"Attempting to fetch VAEs from fallback URL: {vaes_url}")
                    response_vaes = requests.get(vaes_url, timeout=10)
                    if response_vaes.status_code == 200:
                        vaes_list.extend(response_vaes.json())
                        log_stderr(f"Fetched {len(response_vaes.json())} VAEs from {vaes_url}")
                    else:
                        log_stderr(f"/vae endpoint returned {response_vaes.status_code}")
                except requests.exceptions.RequestException as e_vae:
                    log_stderr(f"Could not fetch /vae: {str(e_vae)}")
            environment_data["vaes"] = list(set(vaes_list))

            # ControlNets
            controlnets_list = []
            # ControlNets are often loaded by specific nodes, e.g., "ControlNetLoader"
            # For simplicity, we'll try the direct endpoint first, then consider node parsing if needed.
            try:
                controlnets_url = f"{COMFYUI_BASE_URL}/controlnets"
                log_stderr(f"Attempting to fetch controlnets from URL: {controlnets_url}")
                response_cn = requests.get(controlnets_url, timeout=10)
                if response_cn.status_code == 200:
                     controlnets_list.extend(response_cn.json())
                     log_stderr(f"Fetched {len(response_cn.json())} controlnets from {controlnets_url}")
                else:
                    log_stderr(f"/controlnets endpoint returned {response_cn.status_code}. ControlNets might need parsing from specific loader nodes in object_info.")
            except requests.exceptions.RequestException as e_cn:
                log_stderr(f"Could not fetch /controlnets: {str(e_cn)}. ControlNets might need parsing from specific loader nodes in object_info.")
            environment_data["controlnets"] = list(set(controlnets_list))

        except requests.exceptions.HTTPError as e_http:
            err_msg = f"HTTP error fetching environment from ComfyUI API '{object_info_url}'. Status: {e_http.response.status_code}. Error: {str(e_http)}"
            log_stderr(err_msg)
            return {"status": "error", "error": err_msg}
        except requests.exceptions.RequestException as e_req: # Catches DNS, Connection, Timeout errors
            err_msg = f"Request error fetching environment from ComfyUI API '{object_info_url}'. Is ComfyUI running and accessible at {COMFYUI_BASE_URL}? Error: {str(e_req)}"
            log_stderr(err_msg)
            return {"status": "error", "error": err_msg}
        except json.JSONDecodeError as e_json:
            err_msg = f"Failed to parse JSON from ComfyUI API '{object_info_url}'. Response might not be valid JSON. Error: {str(e_json)}"
            log_stderr(err_msg)
            # Attempt to log part of the response text if available
            try:
                log_stderr(f"Response text (first 200 chars): {response.text[:200] if response else 'No response object'}")
            except Exception as log_e:
                log_stderr(f"Could not log response text: {str(log_e)}")
            return {"status": "error", "error": err_msg}
        
        log_stderr(f"Successfully discovered environment. Checkpoints: {len(environment_data.get('checkpoints',[]))}, Samplers: {len(environment_data.get('samplers',[]))}, Schedulers: {len(environment_data.get('schedulers',[]))}, LoRAs: {len(environment_data.get('loras',[]))}, VAEs: {len(environment_data.get('vaes',[]))}, ControlNets: {len(environment_data.get('controlnets',[]))}")
        return {"status": "success", "result": json.dumps(environment_data)}

    except Exception as e:
        # Generic exception handler for unexpected errors
        error_message = f"Failed to discover ComfyUI environment due to an unexpected error: {str(e)}"
        log_stderr(error_message)
        if traceback: # Log traceback if module was imported
            log_stderr(f"Traceback: {traceback.format_exc()}")
        return {"status": "error", "error": error_message}

def handle_describe_node(params):
    """
    Fetches and returns detailed information about a specific ComfyUI node.
    """
    try:
        import requests
        import traceback
    except ImportError:
        log_stderr("Critical: 'requests' or 'traceback' library is not installed or accessible.")
        return {"status": "error", "error": "A required library (requests/traceback) is not available."}

    node_class_type = params.get("node_class_type")
    if not node_class_type:
        return {"status": "error", "error": "Missing required parameter: 'node_class_type'."}

    object_info_url = f"{COMFYUI_BASE_URL}/object_info"
    try:
        log_stderr(f"Fetching object_info for node '{node_class_type}' from: {object_info_url}")
        response = requests.get(object_info_url, timeout=45)
        response.raise_for_status()
        full_object_info = response.json()

        if node_class_type not in full_object_info:
            return {"status": "error", "error": f"Node class type '{node_class_type}' not found in ComfyUI environment."}

        node_info = full_object_info[node_class_type]
        
        result = {
            "class_type": node_class_type,
            "display_name": node_info.get("display_name", node_class_type),
            "category": node_info.get("category", "unknown"),
            "inputs": [],
            "outputs": []
        }

        # Process inputs
        def process_input_section(input_section, is_required):
            for name, config in input_section.items():
                input_details = {"name": name, "required": is_required}
                if isinstance(config, list) and config:
                    if isinstance(config[0], list):
                        input_details["type"] = "COMBO"
                        input_details["options"] = config[0]
                    else:
                        input_details["type"] = config[0]
                    if len(config) > 1 and isinstance(config[1], dict):
                        input_details.update(config[1])
                else:
                    input_details["type"] = "UNKNOWN"
                result["inputs"].append(input_details)

        raw_inputs = node_info.get("input", {})
        process_input_section(raw_inputs.get("required", {}), True)
        process_input_section(raw_inputs.get("optional", {}), False)

        # Process outputs
        output_types = node_info.get("output", [])
        output_names = node_info.get("output_name", [])
        
        if not output_names and output_types:
            output_names = [str(t) for t in output_types]

        for i, out_type in enumerate(output_types):
            output_details = {
                "type": out_type,
                "name": output_names[i] if i < len(output_names) else f"output_{i+1}"
            }
            result["outputs"].append(output_details)

        return {"status": "success", "result": json.dumps(result, indent=2)}

    except requests.exceptions.RequestException as e_req:
        err_msg = f"Request error fetching node info from ComfyUI API '{object_info_url}'. Is ComfyUI running? Error: {str(e_req)}"
        log_stderr(err_msg)
        return {"status": "error", "error": err_msg}
    except Exception as e:
        error_message = f"Failed to describe node '{node_class_type}' due to an unexpected error: {str(e)}"
        log_stderr(error_message)
        log_stderr(f"Traceback: {traceback.format_exc()}")
        return {"status": "error", "error": error_message}


def handle_generate_workflow(params):
    # Adapted from VCPCOMfyTEST/main.py
    # Uses log_stderr instead of log_message
    # Assumes traceback is imported
    ai_workflow_description_str = params.get("ai_workflow_description")
    if not ai_workflow_description_str:
        log_stderr("Error: 'ai_workflow_description' not found in params for handle_generate_workflow.")
        return {"status": "error", "error": "Missing 'ai_workflow_description' in input parameters."}
    try:
        ai_workflow_data = json.loads(ai_workflow_description_str) if isinstance(ai_workflow_description_str, str) else ai_workflow_description_str
    except json.JSONDecodeError as e:
        log_stderr(f"Error decoding JSON for 'ai_workflow_description': {str(e)}. Received (first 500 chars): {str(ai_workflow_description_str)[:500]}")
        return {"status": "error", "error": f"Invalid JSON in 'ai_workflow_description': {str(e)}"}
    if not isinstance(ai_workflow_data, dict) or not isinstance(ai_workflow_data.get("nodes"), list):
        log_stderr("Error: 'nodes' key is missing or not a list in ai_workflow_description.")
        return {"status": "error", "error": "AI workflow description must be a dictionary with a 'nodes' list."}
    
    comfy_workflow = {}
    ai_to_comfy_id_map = {}
    next_comfy_node_id = 1 # ComfyUI node IDs are strings
    
    try:
        for ai_node_spec in ai_workflow_data["nodes"]:
            if not isinstance(ai_node_spec, dict):
                log_stderr(f"Error: Node specification is not a dictionary: {ai_node_spec}")
                return {"status": "error", "error": "Invalid node specification: node element must be a dictionary."}
            
            ai_node_id = ai_node_spec.get("ai_node_id")
            class_type = ai_node_spec.get("class_type")
            
            if not (isinstance(ai_node_id, str) and ai_node_id): # Must be non-empty string
                log_stderr(f"Error: Missing or invalid 'ai_node_id' (must be non-empty string) in node spec: {ai_node_spec}")
                return {"status": "error", "error": "Each node must have a valid, non-empty 'ai_node_id' string."}
            if not (isinstance(class_type, str) and class_type): # Must be non-empty string
                log_stderr(f"Error: Missing or invalid 'class_type' (must be non-empty string) for ai_node_id '{ai_node_id}'.")
                return {"status": "error", "error": f"Node '{ai_node_id}' must have a valid, non-empty 'class_type' string."}
            if ai_node_id in ai_to_comfy_id_map:
                log_stderr(f"Error: Duplicate 'ai_node_id' found: '{ai_node_id}'.")
                return {"status": "error", "error": f"Duplicate 'ai_node_id': '{ai_node_id}'. IDs must be unique."}
            
            current_comfy_id = str(next_comfy_node_id)
            ai_to_comfy_id_map[ai_node_id] = current_comfy_id
            next_comfy_node_id += 1
            
            comfy_node = {
                "inputs": {}, 
                "class_type": class_type, 
                "_meta": {"title": ai_node_spec.get("display_name", class_type)}
            }
            
            node_inputs = ai_node_spec.get("inputs", {})
            if not isinstance(node_inputs, dict): 
                log_stderr(f"Warning: 'inputs' for ai_node_id '{ai_node_id}' is not a dictionary, treating as empty. Value: {node_inputs}")
                node_inputs = {}
                
            for input_name, input_value in node_inputs.items():
                if isinstance(input_value, list) and len(input_value) == 2 and \
                   isinstance(input_value[0], str) and isinstance(input_value[1], int):
                    ref_ai_node_id, output_idx = input_value
                    ref_comfy_id = ai_to_comfy_id_map.get(ref_ai_node_id)
                    
                    if ref_comfy_id is None:
                        log_stderr(f"Error: Unresolved link. Node '{ai_node_id}' input '{input_name}' references undefined ai_node_id '{ref_ai_node_id}'.")
                        return {"status": "error", "error": f"Workflow generation failed: node '{ai_node_id}' links to undefined source node ID '{ref_ai_node_id}' for input '{input_name}'."}
                    comfy_node["inputs"][input_name] = [ref_comfy_id, output_idx]
                else:
                    comfy_node["inputs"][input_name] = input_value
            
            comfy_workflow[current_comfy_id] = comfy_node
            
        log_stderr(f"Successfully generated ComfyUI workflow with {len(comfy_workflow)} nodes.")
        return {"status": "success", "result": json.dumps(comfy_workflow)}
        
    except Exception as e:
        current_ai_node_id_for_error = 'unknown_at_loop_level'
        if 'ai_node_spec' in locals() and isinstance(ai_node_spec, dict):
            current_ai_node_id_for_error = ai_node_spec.get('ai_node_id', 'unknown_in_spec')
        
        log_stderr(f"Error during workflow node processing for AI node '{current_ai_node_id_for_error}': {str(e)}")
        # traceback is imported at top level
        log_stderr(f"Traceback: {traceback.format_exc()}")
        return {"status": "error", "error": f"Workflow generation failed processing node '{current_ai_node_id_for_error}': {str(e)}."}


def modify_workflow_params(workflow_data, ai_params):
    # Adapted from VCPCOMfyTEST/main.py
    # Uses log_stderr instead of log_message
    # Assumes json is imported
    log_stderr(f"Attempting to modify workflow with params: {ai_params}")
    
    prompt_node_id = None
    negative_prompt_node_id = None
    ksampler_node_id = None
    checkpoint_loader_node_id = None

    for node_id, node_info in workflow_data.items():
        class_type = node_info.get("class_type") or node_info.get("type") 
        meta_title = node_info.get("_meta", {}).get("title", "").lower()

        if class_type == "CLIPTextEncode":
            is_likely_negative = "negative" in meta_title
            if "widgets_values" in node_info and isinstance(node_info["widgets_values"], list) and node_info["widgets_values"]:
                if "negative" in str(node_info["widgets_values"][0]).lower():
                    is_likely_negative = True
            
            if is_likely_negative and negative_prompt_node_id is None:
                negative_prompt_node_id = node_id
            elif not is_likely_negative and prompt_node_id is None: 
                prompt_node_id = node_id
        
        elif class_type == "KSampler":
            ksampler_node_id = node_id
        
        elif class_type in ["CheckpointLoader", "CheckpointLoaderSimple", "Efficient Loader", "UltimateSDUpscale"]:
            if checkpoint_loader_node_id is None: 
                checkpoint_loader_node_id = node_id

    def apply_param(target_node_id, param_key_in_ai, input_field_name, widget_index=0):
        if ai_params.get(param_key_in_ai) is not None and target_node_id and workflow_data.get(target_node_id): 
            node_to_modify = workflow_data[target_node_id]
            value_to_set = ai_params[param_key_in_ai]
            
            if "inputs" not in node_to_modify: 
                node_to_modify["inputs"] = {}
            node_to_modify["inputs"][input_field_name] = value_to_set
            
            if "widgets_values" in node_to_modify and isinstance(node_to_modify["widgets_values"], list) and \
               len(node_to_modify["widgets_values"]) > widget_index:
                try:
                    node_to_modify["widgets_values"][widget_index] = value_to_set
                except IndexError:
                    log_stderr(f"Warning: widget_index {widget_index} out of bounds for node {target_node_id} widgets_values.")

            log_stderr(f"Set '{param_key_in_ai}' (value: {value_to_set}) for node {target_node_id} (input: {input_field_name})")

    apply_param(prompt_node_id, "prompt", "text")
    apply_param(negative_prompt_node_id, "negative_prompt", "text")
    apply_param(checkpoint_loader_node_id, "model_name", "ckpt_name")

    if ksampler_node_id and workflow_data.get(ksampler_node_id):
        if "inputs" not in workflow_data[ksampler_node_id]:
            workflow_data[ksampler_node_id]["inputs"] = {}
        
        ksampler_inputs = workflow_data[ksampler_node_id]["inputs"] 
        for p_name in ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"]:
            if p_name in ai_params: 
                ksampler_inputs[p_name] = ai_params[p_name]
                log_stderr(f"Set KSampler param '{p_name}' to '{ai_params[p_name]}' for node {ksampler_node_id}")

    if "custom_params" in ai_params:
        custom_params_input = ai_params["custom_params"]
        try:
            custom_params_dict = {}
            if isinstance(custom_params_input, str):
                try:
                    custom_params_dict = json.loads(custom_params_input)
                except json.JSONDecodeError as e_json_custom:
                    log_stderr(f"Error decoding custom_params JSON string: {str(e_json_custom)}. String was: {custom_params_input}")
            elif isinstance(custom_params_input, dict):
                custom_params_dict = custom_params_input
            else:
                log_stderr(f"Warning: 'custom_params' is neither a string nor a dict. Type: {type(custom_params_input)}. Ignoring.")

            if isinstance(custom_params_dict, dict):
                for node_id_target, node_mod_params in custom_params_dict.items():
                    if node_id_target in workflow_data and isinstance(node_mod_params, dict):
                        if "inputs" not in workflow_data[node_id_target]:
                            workflow_data[node_id_target]["inputs"] = {}
                        
                        for param_name, param_value in node_mod_params.items():
                            workflow_data[node_id_target]["inputs"][param_name] = param_value
                            log_stderr(f"Set custom_param '{param_name}' (value: {param_value}) for node {node_id_target}")
                    else:
                        log_stderr(f"Warning: Node ID '{node_id_target}' from custom_params not found in workflow or its params not a dict.")
        except Exception as e_cp: 
            log_stderr(f"Error processing custom_params: {str(e_cp)}")
            # traceback is imported at top level
            log_stderr(f"Traceback: {traceback.format_exc()}")
    return workflow_data, None # save_image_node_id is not returned by this version



def handle_generate_image(params):
    # --- Ensure 'requests' is available ---
    try:
        import requests
    except ImportError:
        return {"status": "error", "error": "The 'requests' library is not installed. Please add it to VCPToolBox requirements."}

    workflow_api_data = None
    workflow_json_str = params.get("workflow_json")
    workflow_id_filename = params.get("workflow_id")

    if workflow_json_str:
        log_stderr("Loading workflow from 'workflow_json' parameter.")
        # Define a variable to hold the string for parsing, for logging in case of error
        content_to_parse = ""
        try:
            if isinstance(workflow_json_str, str):
                content_to_parse = workflow_json_str
                # VCP might wrap complex string parameters. Check for and strip markers.
                log_stderr(f"Received raw workflow_json string (first 100 chars): {content_to_parse[:100]}")
                
                start_marker = "始"
                end_marker = "末"

                if content_to_parse.startswith(start_marker) and content_to_parse.endswith(end_marker):
                    log_stderr(f"Found '{start_marker}' and '{end_marker}' markers. Stripping them.")
                    content_to_parse = content_to_parse[len(start_marker):-len(end_marker)]
                
                workflow_api_data = json.loads(content_to_parse)
            else: # Assume it's already a dict/list (parsed by VCP)
                workflow_api_data = workflow_json_str
                content_to_parse = str(workflow_api_data) # For logging

            # --- FIX: Convert full UI workflow format to the simple dict format needed for modification ---
            if isinstance(workflow_api_data.get("nodes"), list):
                log_stderr("Detected full UI workflow format. Converting to simple dict format for internal processing.")
                workflow_api_data = {str(node['id']): node for node in workflow_api_data['nodes']}

        except json.JSONDecodeError as e:
            log_stderr(f"Error decoding 'workflow_json' after stripping markers: {str(e)}")
            log_stderr(f"Content that failed parsing (first 200 chars): {content_to_parse[:200]}")
            return {"status": "error", "error": f"Parameter 'workflow_json' is not valid JSON after attempting to strip markers: {str(e)}"}
    elif workflow_id_filename:
        log_stderr(f"Loading workflow from file: {workflow_id_filename}")
        workflow_filepath = os.path.join(COMFYUI_WORKFLOWS_PATH_ABS, workflow_id_filename)
        if not os.path.isfile(workflow_filepath):
            return {"status": "error", "error": f"Workflow file not found: {workflow_filepath}"}
        try:
            with open(workflow_filepath, 'r', encoding='utf-8') as f:
                workflow_api_data = json.load(f)
        except Exception as e:
            log_stderr(f"Error loading workflow file {workflow_filepath}: {str(e)}")
            return {"status": "error", "error": f"Failed to load workflow '{workflow_id_filename}': {str(e)}"}
    else:
        return {"status": "error", "error": "Either 'workflow_id' or 'workflow_json' parameter is required to generate an image."}

    # Modify workflow with AI parameters
    # This needs to be robust. The example `comfyui-mcp-server` uses a DEFAULT_MAPPING.
    # For a VCP plugin, you might need to instruct AI on how to specify node IDs for params,
    # or have very well-defined workflow templates.
    
    client_id = str(uuid.uuid4())
    modified_workflow_api_data, save_image_node_id = modify_workflow_params(workflow_api_data, params)
    
    # Add client_id to the workflow payload (ComfyUI uses this for tracking/WebSocket)
    # Also, if we identified a SaveImage node, we might be able to tell ComfyUI to associate
    # the preview with this client_id, though this is more for WebSocket previews.
    # For direct /prompt, client_id is good for general tracking.
    prompt_payload = {"prompt": modified_workflow_api_data, "client_id": client_id}


    try:
        log_stderr(f"Sending prompt to ComfyUI: {COMFYUI_BASE_URL}/prompt")
        # log_stderr(f"Payload (first 500 chars): {json.dumps(prompt_payload)[:500]}") # Can be very verbose
        
        response = requests.post(f"{COMFYUI_BASE_URL}/prompt", json=prompt_payload, timeout=COMFYUI_REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
        
        prompt_response_data = response.json()
        prompt_id = prompt_response_data.get('prompt_id')
        
        if not prompt_id:
            log_stderr(f"ComfyUI did not return a prompt_id. Response: {prompt_response_data}")
            return {"status": "error", "error": "ComfyUI did not return a prompt_id."}
        
        log_stderr(f"ComfyUI prompt accepted. Prompt ID: {prompt_id}")

        # --- Poll for history ---
        # This is a simplified polling mechanism.
        # A more robust solution might use WebSockets or a more intelligent polling strategy.
        max_poll_attempts = COMFYUI_REQUEST_TIMEOUT_SECONDS // 2 # Roughly, poll every 2s
        for attempt in range(max_poll_attempts):
            time.sleep(2) # Wait 2 seconds before polling
            # Use file logging since stderr is not captured by VCP server log
            with open(log_file_path, "a", encoding="utf-8") as f:
                f.write(f"Polling history for prompt_id {prompt_id} (Attempt {attempt + 1}/{max_poll_attempts})\n")

            history_response = requests.get(f"{COMFYUI_BASE_URL}/history/{prompt_id}", timeout=10)
            history_response.raise_for_status()
            history_data = history_response.json()
            
            # ComfyUI history returns a dict where keys are prompt_ids.
            # When the prompt is done, its entry will be in the history.
            if prompt_id in history_data:
                # Log the full history data to the debug file for inspection
                with open(log_file_path, "a", encoding="utf-8") as f:
                    f.write(f"--- History data received from ComfyUI for prompt_id {prompt_id} ---\n")
                    f.write(json.dumps(history_data, indent=2, ensure_ascii=False))
                    f.write("\n\n")

                prompt_execution_result = history_data[prompt_id]
                outputs = prompt_execution_result.get("outputs", {})
                
                image_outputs_list = []
                # Outputs are keyed by node ID. We need to find the node(s) that produce images.
                # This often means looking for nodes of type 'SaveImage' or similar,
                # or nodes that have 'images' in their output structure.
                for node_id_output, node_output_data in outputs.items():
                    if "images" in node_output_data: # Common output key for images
                        for image_info in node_output_data["images"]:
                            filename = image_info.get("filename")
                            subfolder = image_info.get("subfolder", "") # May be empty
                            img_type = image_info.get("type", "output") # output, temp, input

                            if filename:
                                image_url = f"{COMFYUI_BASE_URL}/view?filename={filename}&subfolder={subfolder}&type={img_type}"
                                if COMFYUI_OUTPUT_IMAGE_TYPE == "base64":
                                    try:
                                        img_response = requests.get(image_url, timeout=30)
                                        img_response.raise_for_status()
                                        import base64 # Ensure this import is at the top if used
                                        img_base64 = base64.b64encode(img_response.content).decode('utf-8')
                                        image_outputs_list.append({"type": "base64", "filename": filename, "data": img_base64})
                                    except Exception as e_img:
                                        log_stderr(f"Error fetching or encoding image {filename}: {str(e_img)}")
                                        # Fallback to URL if base64 fails for this image
                                        image_outputs_list.append({"type": "url", "filename": filename, "data": image_url, "error_base64": str(e_img)})
                                else: # 'url'
                                    image_outputs_list.append({"type": "url", "filename": filename, "data": image_url})
                
                if not image_outputs_list:
                    # Log to our debug file for inspection
                    with open(log_file_path, "a", encoding="utf-8") as f:
                        f.write(f"--- No image outputs found in result for prompt_id {prompt_id} ---\n")
                        f.write(f"Outputs object was: {json.dumps(outputs, indent=2, ensure_ascii=False)}\n\n")
                    return {"status": "error", "error": "ComfyUI processed the request but no image outputs were found."}

                return {"status": "success", 
                        "result": json.dumps({
                            "image_outputs": image_outputs_list,
                            "prompt_id": prompt_id,
                            "comfyui_raw_outputs": outputs # Optional: include raw output for debugging
                        })}
            # If prompt_id not in history, it's still processing (or an error occurred not caught here)
            # Check for specific "status" updates if ComfyUI API provides them for queued items.
            # For now, simple polling continues.

        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"Polling timed out for prompt_id {prompt_id}\n")
        return {"status": "error", "error": f"ComfyUI task polling timed out for prompt ID: {prompt_id}."}

    except requests.exceptions.RequestException as e:
        error_details = str(e)
        if e.response is not None:
            try:
                error_details += f" | Response: {e.response.text[:200]}" # Log part of response
            except Exception:
                pass # Ignore if response text itself is problematic
        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"--- HTTP Request error: {error_details} ---\n")
        return {"status": "error", "error": f"ComfyUI API request failed: {error_details}"}
    except Exception as e:
        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"--- General error in handle_generate_image: {str(e)} ---\n")
        return {"status": "error", "error": f"Failed to generate image: {str(e)}"}


def add_file_based_logging_to_function(func):
    """
    A decorator to inject file-based logging into a function.
    This is a conceptual placeholder for how one might refactor this.
    For now, we are adding the logging code manually for clarity and simplicity.
    """
    pass

# --- Main STDIO Handling ---
if __name__ == "__main__":
    # --- Debug logging to a file inside the plugin directory ---
    plugin_dir_for_log = os.path.dirname(os.path.abspath(__file__))
    log_file_path = os.path.join(plugin_dir_for_log, "debug_log.txt")

    output = {}
    raw_input = "" # Initialize to handle potential read errors
    try:
        raw_input = sys.stdin.read()

        # Write raw input to the debug log file for inspection
        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"--- Execution @ {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
            f.write(f"Raw stdin received: {raw_input}\n")

        if not raw_input:
            output = {"status": "error", "error": "No input received from VCP server."}
        else:
            input_data = json.loads(raw_input)
            
            # Log parsed data to the file
            with open(log_file_path, "a", encoding="utf-8") as f:
                 f.write(f"Successfully parsed data: {input_data}\n\n")
            
            command = input_data.get("command")
            # FIX: The logs show that parameters are in the root object, not nested under a "params" key.
            # We will use the entire input_data object as the source of parameters for the handlers.
            params = input_data

            if command == "generate_image":
                output = handle_generate_image(params)
            elif command == "list_workflows":
                output = handle_list_workflows(params)
            elif command == "discover_environment":
                output = handle_discover_environment(params)
            elif command == "describe_node":
                output = handle_describe_node(params)
            elif command == "generate_workflow":
                output = handle_generate_workflow(params)
            # Infer 'generate_image' if command is missing but workflow data is present.
            elif command is None and (params.get("workflow_id") or params.get("workflow_json")):
                log_stderr("Command not specified, but 'workflow_id' or 'workflow_json' found. Assuming 'generate_image'.")
                output = handle_generate_image(params)
            else:
                output = {"status": "error", "error": f"Unknown or unspecified command. Received command: '{command}', Params: {params}"}
        
    except json.JSONDecodeError as e:
        # Log the parsing error to our debug file
        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"JSONDecodeError: {str(e)}\n")
            f.write(f"--- Failed raw input was: ---\n{raw_input}\n--------------------------\n\n")
        output = {"status": "error", "error": f"Invalid JSON input: {str(e)}"}
    except Exception as e:
        # Log any other critical error to our debug file
        import traceback
        tb_str = traceback.format_exc()
        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"--- Critical Error: {str(e)} ---\n")
            f.write(tb_str)
            f.write("\n\n")
        output = {"status": "error", "error": f"Plugin internal error: {str(e)}"}
    
    # Final output to VCP server
    try:
        sys.stdout.write(json.dumps(output))
        sys.stdout.flush()
    except Exception as e:
        # This is a last resort if even stringifying the error fails.
        fallback_error = '{{"status": "error", "error": "Plugin failed to produce a serializable JSON output after an error."}}'
        # We can't use log_stderr effectively, but we can try to write to our own log one last time
        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"--- FATAL: Could not serialize final output to JSON. Error: {str(e)} ---\n")
        sys.stdout.write(fallback_error)
        sys.stdout.flush()
