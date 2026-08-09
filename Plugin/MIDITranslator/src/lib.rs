//! MIDITranslator - VCP生态系统的音乐语言翻译官
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::panic;
use std::cmp::Ordering;
use std::collections::VecDeque;

// 导入midly
// use midly::{Smf, TrackEventKind, MidiMessage, MetaMessage};
use midly::{Smf, TrackEventKind, MetaMessage};

// 全局常量定义
const NOTE_NAMES: [&str; 12] = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const DEFAULT_BPM: u32 = 120;
const DEFAULT_TIME_SIG: &str = "4/4";
const DEFAULT_TPB: u16 = 480;

// MIDI常量
const MIDI_HEADER: [u8; 4] = [b'M', b'T', b'h', b'd'];
const MIDI_TRACK_HEADER: [u8; 4] = [b'M', b'T', b'r', b'k'];
const END_OF_TRACK: [u8; 4] = [0x00, 0xFF, 0x2F, 0x00];

// ==================== 核心数据结构 ====================

/// 自主设计的MIDI事件类型 - 只包含对AI音乐创作重要的类型
#[derive(Debug, Clone)]
enum MidiEventType {
    // 基础音符事件
    NoteOn { channel: u8, note: u8, velocity: u8 },
    NoteOff { channel: u8, note: u8 },
    
    // 连续控制
    Controller { channel: u8, controller: u8, value: u8 },
    PitchBend { channel: u8, value: i16 },
    
    // 触感表达
    Aftertouch { channel: u8, note: u8, pressure: u8 },
    ChannelAftertouch { channel: u8, pressure: u8 },
    
    // 文本元信息
    Text(String),
    Lyric(String),    // 特殊标记：触发人声/旋律分离检查
    Marker(String),
    
    // 音乐结构元数据
    Tempo(u32),    // 微秒每四分音符
    TimeSignature { numerator: u8, denominator: u8, clocks_per_click: u8, thirty_seconds_per_quarter: u8 },
    
    // 轨道元数据
    TrackName(String),
}

/// 轨道事件 - 包含时间增量和事件类型
#[derive(Debug, Clone)]
struct TrackEvent {
    delta_time: u32,
    event_type: MidiEventType,
}

/// 自主设计的MIDI文件结构 - 针对DSL优化
struct MidiFile {
    format: u16,                    // 0,1,2
    ticks_per_quarter: u16,        // 时间精度
    tracks: Vec<Vec<TrackEvent>>,  // 轨道数据
}

impl MidiFile {
    /// 创建新的MIDI文件
    fn new(format: u16, ticks_per_quarter: u16) -> Self {
        Self {
            format,
            ticks_per_quarter,
            tracks: Vec::new(),
        }
    }
    
    /// 添加轨道
    fn add_track(&mut self, events: Vec<TrackEvent>) {
        self.tracks.push(events);
    }
    
    /// 生成MIDI二进制数据 - 完全自主实现的编码器
    fn to_bytes(&self) -> Vec<u8> {
        // 预估缓冲区大小以提高性能
        let estimated_size = 14 + self.tracks.len() * 1024;
        let mut bytes = Vec::with_capacity(estimated_size);
        
        // 1. 写入文件头
        self.write_header(&mut bytes);
        
        // 2. 写入每个轨道
        for track in &self.tracks {
            self.write_track(&mut bytes, track);
        }
        
        bytes.shrink_to_fit();
        bytes
    }
    
    /// 写入MIDI文件头
    fn write_header(&self, bytes: &mut Vec<u8>) {
        // MThd
        bytes.extend_from_slice(&MIDI_HEADER);
        
        // 头部长度：总是6
        bytes.extend(&6u32.to_be_bytes());
        
        // 格式类型
        bytes.extend(&self.format.to_be_bytes());
        
        // 轨道数
        let track_count = self.tracks.len() as u16;
        bytes.extend(&track_count.to_be_bytes());
        
        // 每四分音符的ticks数
        bytes.extend(&self.ticks_per_quarter.to_be_bytes());
    }
    
    /// 写入轨道数据
    fn write_track(&self, bytes: &mut Vec<u8>, track: &[TrackEvent]) {
        // MTrk
        bytes.extend_from_slice(&MIDI_TRACK_HEADER);
        
        // 先写入轨道数据到临时缓冲区
        let mut track_data = Vec::new();
        // 按顺序写入事件
        for event in track {
            // 写入delta time（变长编码）
            self.write_variable_length(&mut track_data, event.delta_time);
            
            // 写入事件数据
            self.write_event_data(&mut track_data, &event.event_type);
        }
        
        // 写入轨道结束标志
        track_data.extend_from_slice(&END_OF_TRACK);
        
        // 写入轨道数据长度
        bytes.extend(&(track_data.len() as u32).to_be_bytes());
        
        // 写入轨道数据
        bytes.extend(track_data);
    }
    
    /// 写入事件数据
    fn write_event_data(&self, bytes: &mut Vec<u8>, event_type: &MidiEventType) {
        match event_type {
            MidiEventType::NoteOn { channel, note, velocity } => {
                bytes.push(0x90 | (channel & 0x0F));
                bytes.push(*note);
                bytes.push(*velocity);
            }
            MidiEventType::NoteOff { channel, note } => {
                bytes.push(0x80 | (channel & 0x0F));
                bytes.push(*note);
                bytes.push(0x00); // NoteOff速度通常为0
            }
            MidiEventType::Controller { channel, controller, value } => {
                bytes.push(0xB0 | (channel & 0x0F));
                bytes.push(*controller);
                bytes.push(*value);
            }
            MidiEventType::PitchBend { channel, value } => {
                let adjusted = ((*value as i32 + 8192) & 0x3FFF) as u16;
                let lsb = (adjusted & 0x7F) as u8;
                let msb = ((adjusted >> 7) & 0x7F) as u8;
                
                bytes.push(0xE0 | (channel & 0x0F));
                bytes.push(lsb);
                bytes.push(msb);
            }
            MidiEventType::Aftertouch { channel, note, pressure } => {
                bytes.push(0xA0 | (channel & 0x0F));
                bytes.push(*note);
                bytes.push(*pressure);
            }
            MidiEventType::ChannelAftertouch { channel, pressure } => {
                bytes.push(0xD0 | (channel & 0x0F));
                bytes.push(*pressure);
            }
            MidiEventType::Text(text) => {
                bytes.push(0xFF); // Meta event
                bytes.push(0x01); // Text event
                self.write_meta_text(bytes, text);
            }
            MidiEventType::Lyric(text) => {
                bytes.push(0xFF); // Meta event
                bytes.push(0x05); // Lyric event
                self.write_meta_text(bytes, text);
            }
            MidiEventType::Marker(text) => {
                bytes.push(0xFF); // Meta event
                bytes.push(0x06); // Marker event
                self.write_meta_text(bytes, text);
            }
            MidiEventType::Tempo(tempo) => {
                bytes.push(0xFF); // Meta event
                bytes.push(0x51); // Tempo event
                bytes.push(0x03); // Length = 3
                bytes.push(((tempo >> 16) & 0xFF) as u8);
                bytes.push(((tempo >> 8) & 0xFF) as u8);
                bytes.push((tempo & 0xFF) as u8);
            }
            MidiEventType::TimeSignature { 
                numerator, 
                denominator, 
                clocks_per_click, 
                thirty_seconds_per_quarter 
            } => {
                bytes.push(0xFF); // Meta event
                bytes.push(0x58); // Time signature event
                bytes.push(0x04); // Length = 4
                bytes.push(*numerator);
                bytes.push((*denominator as f32).log2() as u8);
                bytes.push(*clocks_per_click);
                bytes.push(*thirty_seconds_per_quarter);
            }
            MidiEventType::TrackName(name) => {
                bytes.push(0xFF); // Meta event
                bytes.push(0x03); // Track name event
                self.write_meta_text(bytes, name);
            }
        }
    }
    
    /// 写入元文本事件
    fn write_meta_text(&self, bytes: &mut Vec<u8>, text: &str) {
        self.write_variable_length(bytes, text.len() as u32);
        bytes.extend(text.as_bytes());
    }
    
    /// 变长整数编码（Variable-Length Quantity）- 修复版
    fn write_variable_length(&self, bytes: &mut Vec<u8>, mut value: u32) {
        let mut buffer = [0u8; 5];
        let mut position = 4;
        
        buffer[position] = (value & 0x7F) as u8;
        value >>= 7;
        
        while value > 0 {
            position -= 1;
            buffer[position] = ((value & 0x7F) | 0x80) as u8;
            value >>= 7;
        }
        
        bytes.extend_from_slice(&buffer[position..]);
    }
}

// ==================== 主结构体 ====================

#[napi]
pub struct MidiQuantizer {
    // 可以添加配置状态
}

#[napi]
impl MidiQuantizer {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {}
    }

    /// 核心API1：MIDI -> DSL（无损转换）
    #[napi]
    pub fn quantize(&self, midi_data: Buffer) -> Result<String> {
        panic::catch_unwind(|| self.quantize_internal(&midi_data))
            .map_err(|e| Error::new(Status::GenericFailure, format!("Rust panic: {:?}", e)))?
    }

    /// 核心API2：DSL -> MIDI（包含验证）
    #[napi]
    pub fn generate(&self, dsl: String) -> Result<Buffer> {
        self.generate_internal(&dsl)
    }

    /// 核心API3：DSL语法验证
    #[napi]
    pub fn validate_dsl(&self, dsl: String) -> Result<bool> {
        let errors = self.validate_dsl_internal(&dsl);
        Ok(errors.is_empty())
    }
    
    /// 辅助API：获取验证错误详情
    #[napi]
    pub fn validate_dsl_with_details(&self, dsl: String) -> Result<Vec<String>> {
        Ok(self.validate_dsl_internal(&dsl))
    }
    
    /// 辅助API：提取特定类型的事件
    #[napi]
    pub fn extract_events(&self, dsl: String, event_type: String) -> Result<Vec<String>> {
        let events: Vec<String> = dsl.lines()
            .filter(|line| !line.starts_with("Timeline:"))
            .flat_map(|line| {
                line.split_whitespace()
                    .filter(|token| token.starts_with(&format!("[{}", event_type)))
                    .map(String::from)
            })
            .collect();
        
        Ok(events)
    }
}

// ==================== 内部实现 ====================

impl MidiQuantizer {
    /// 量化内部实现：MIDI二进制 -> DSL字符串
    fn quantize_internal(&self, midi_data: &[u8]) -> Result<String> {
        // 使用midly作为可靠的解析器
        let smf = Smf::parse(midi_data)
            .map_err(|e| Error::new(Status::InvalidArg, format!("MIDI 解析失败: {:?}", e)))?;

        // 1. 获取时间精度
        let ticks_per_beat = match smf.header.timing {
            midly::Timing::Metrical(tp) => tp.as_int() as f64,
            midly::Timing::Timecode(fps, subframes) => {
                let fps_val = fps.as_f32();
                let subframes_val = subframes as f32;
                ((fps_val * subframes_val) / 4.0) as f64
            }
        };

        // 2. 提取全局元数据（时间线）
        let mut timeline_events = Vec::new();
        for track in &smf.tracks {
            let mut tick = 0u32;
            for event in track {
                tick += event.delta.as_int();
                if let TrackEventKind::Meta(meta) = &event.kind {
                    match meta {
                        MetaMessage::Tempo(tempo) => {
                            let bpm = 60000000 / tempo.as_int();
                            timeline_events.push((tick, "tempo", bpm.to_string()));
                        }
                        MetaMessage::TimeSignature(numer, denom, clocks_per_click, thirty_seconds_per_quarter) => {
                            let den = 2u32.pow((*denom).into());
                            timeline_events.push((tick, "tsig", 
                                format!("{}/{}/{}/{}", numer, den, clocks_per_click, thirty_seconds_per_quarter)));
                        }
                        _ => {}
                    }
                }
            }
        }

        // 3. 构建时间线DSL
        let timeline_dsl = self.build_timeline_dsl(&smf, ticks_per_beat, &timeline_events);

        // 4. 构建轨道DSL
        let mut track_dsl_parts = Vec::new();
        
        for (track_idx, track) in smf.tracks.iter().enumerate() {
            let track_dsl = self.build_track_dsl(track, track_idx, ticks_per_beat);
            if !track_dsl.is_empty() {
                track_dsl_parts.push(track_dsl);
            }
        }

        // 5. 组合最终DSL
        let mut result = timeline_dsl;
        if !track_dsl_parts.is_empty() {
            result.push('\n');
            result.push_str(&track_dsl_parts.join("\n"));
        }

        Ok(result)
    }
    
    /// 构建时间线DSL
    fn build_timeline_dsl(&self, smf: &Smf, ticks_per_beat: f64, timeline_events: &[(u32, &str, String)]) -> String {
        // 如果没有时间线事件，使用默认值
        if timeline_events.is_empty() {
            let total_ticks = self.calculate_total_ticks(smf);
            return format!(
                "Timeline: [0-{}]{}|{}|TPB{}",
                total_ticks, DEFAULT_BPM, DEFAULT_TIME_SIG, ticks_per_beat as u32
            );
        }
        
        // 构建时间线区间
        let mut timeline_parts = Vec::new();
        let mut prev_tick = 0;
        let mut current_bpm = DEFAULT_BPM;
        let mut current_ts = DEFAULT_TIME_SIG.to_string();

        for (tick, typ, value) in timeline_events {
            if *tick > prev_tick {
                timeline_parts.push(format!(
                    "[{}-{}]{}|{}|TPB{}",
                    prev_tick, tick, current_bpm, current_ts, ticks_per_beat as u32
                ));
            }
            match *typ {
                "tempo" => current_bpm = value.parse().unwrap_or(DEFAULT_BPM),
                "tsig" => {
                    let parts: Vec<&str> = value.split('/').collect();
                    if parts.len() >= 2 {
                        current_ts = format!("{}/{}", parts[0], parts[1]);
                    }
                }
                _ => {}
            }
            prev_tick = *tick;
        }

        let total_ticks = self.calculate_total_ticks(smf);
        if prev_tick < total_ticks {
            timeline_parts.push(format!(
                "[{}-{}]{}|{}|TPB{}",
                prev_tick, total_ticks, current_bpm, current_ts, ticks_per_beat as u32
            ));
        }

        format!("Timeline: {}", timeline_parts.join(" "))
    }
    
/// 构建轨道DSL - 修复版：NoteOff 事件独立记录
fn build_track_dsl(&self, track: &midly::Track, track_idx: usize, ticks_per_barter: f64) -> String {
    let mut events: Vec<String> = Vec::new();
    let mut current_tick = 0u32;

    // 1. 先扫一遍，把 NoteOn/NoteOff 都记下来
    let mut note_events = Vec::new(); // (tick, is_on, note, channel, velocity)

    for evt in track {
        current_tick += evt.delta.as_int();
        if let midly::TrackEventKind::Midi { channel, message } = &evt.kind {
            match message {
                midly::MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                    note_events.push((current_tick, true, key.as_int(), channel.as_int(), vel.as_int()));
                }
                midly::MidiMessage::NoteOn { key, vel } if vel.as_int() == 0 => {
                    note_events.push((current_tick, false, key.as_int(), channel.as_int(), 0));
                }
                midly::MidiMessage::NoteOff { key, vel: _ } => {
                    note_events.push((current_tick, false, key.as_int(), channel.as_int(), 0));
                }
                _ => {}
            }
        }
    }

    // 2. 按 (note, ch) 分组 FIFO 配对
    let mut pairs: std::collections::HashMap<(u8, u8), std::collections::VecDeque<(u32, bool, u8)>> = std::collections::HashMap::new();
    for (tick, is_on, note, ch, vel) in note_events {
        pairs.entry((note, ch))
             .or_insert_with(std::collections::VecDeque::new)
             .push_back((tick, is_on, vel));
    }

    // 3. 生成 DSL 行
    let mut dsl_parts = Vec::new();
    for ((note, ch), mut deque) in pairs {
        deque.make_contiguous().sort_by_key(|&(t, _, _)| t);
        while let Some((start_tick, is_on, vel)) = deque.pop_front() {
            if !is_on { continue; } // 没配对的 NoteOff 忽略
            let start_beat = start_tick as f64 / ticks_per_barter;
            let note_name = midi_to_name(note);
            dsl_parts.push(format!("[{},{},{},ch{}]", note_name, start_beat, vel, ch));

            // 找下一个 NoteOff
            if let Some((end_tick, _, _)) = deque.pop_front() {
                let end_beat = end_tick as f64 / ticks_per_barter;
                dsl_parts.push(format!("[~{},{},ch{}]", note_name, end_beat, ch));
            } else {
                // 真的没有 NoteOff
                dsl_parts.push(format!("[~{},999.0,ch{}]", note_name, ch));
            }
        }
    }

    // 4. 其余事件（CC、PB、Text…）按原逻辑补在后面
    current_tick = 0;
    for evt in track {
        current_tick += evt.delta.as_int();
        let beat = current_tick as f64 / ticks_per_barter;
        if let midly::TrackEventKind::Midi { channel, message } = &evt.kind {
            match message {
                midly::MidiMessage::Controller { controller, value } => {
                    dsl_parts.push(format!("[cc,{},{},{},ch{}]", controller.as_int(), beat, value.as_int(), channel.as_int()));
                }
                midly::MidiMessage::PitchBend { bend } => {
                    let val = bend.as_int() as i32 - 8192;
                    dsl_parts.push(format!("[pb,{},{},ch{}]", beat, val, channel.as_int()));
                }
                _ => {}
            }
        }
    }

    if dsl_parts.is_empty() {
        String::new()
    } else {
        format!("Track{}: {}", track_idx, dsl_parts.join(" "))
    }
}

/// 统一处理 NoteOff：输出 DSL 事件并从 active_notes 移除
    fn output_note_off(
        &self,
        note: u8,
        current_tick: u32,
        active_notes: &mut HashMap<u8, (u32, u8, u8)>,
        ticks_per_beat: f64,
        events: &mut Vec<String>,
        ) {
            if let Some((start_tick, velocity, channel)) = active_notes.remove(&note) {
                let start_beat = start_tick as f64 / ticks_per_beat;
                let end_beat = current_tick as f64 / ticks_per_beat;
                events.push(format!("[{},{},{},ch{}]", midi_to_name(note), start_beat, velocity, channel));
                events.push(format!("[~{},{},ch{}]", midi_to_name(note), end_beat, channel));
            }
        }
    
    
    /// 转义字符串中的特殊字符
    fn escape_string(&self, bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes)
            .replace('"', r#"\""#)
            .replace('\n', r#"\n"#)
            .replace('\r', r#"\r"#)
    }
    
    /// 计算总ticks数
    fn calculate_total_ticks(&self, smf: &Smf) -> u32 {
        smf.tracks
            .iter()
            .flat_map(|t| t.iter().map(|e| e.delta.as_int()))
            .sum()
    }

    /// 生成内部实现：DSL字符串 -> MIDI二进制
    fn generate_internal(&self, dsl: &str) -> Result<Buffer> {
        // 1. 验证DSL
        let errors = self.validate_dsl_internal(dsl);
        if !errors.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("DSL 验证失败: {}", errors.join("; ")),
            ));
        }
        
        // 2. 解析Timeline获取全局参数
        let (global_events, tracks_events) = self.parse_dsl_structure(dsl);
        
        // 3. 创建MIDI文件
        let ticks_per_quarter = self.extract_tpb_from_timeline(dsl).unwrap_or(DEFAULT_TPB);
        let mut midi_file = MidiFile::new(1, ticks_per_quarter);
        
        // 4. 创建元数据轨道（轨道0）
        let conductor_track = self.build_conductor_track(&global_events, ticks_per_quarter as f64);
        midi_file.add_track(conductor_track);
        
        // 5. 创建音乐轨道
        for (track_idx, events) in tracks_events.iter().enumerate() {
            let track_events =
                self.convert_dsl_events_to_midi(events, f64::from(ticks_per_quarter), track_idx);
            midi_file.add_track(track_events);
        }
        
        // 6. 生成二进制数据
        let bytes = midi_file.to_bytes();
        Ok(bytes.into())
    }
    
    /// 1. 解析 DSL 为：全局事件 + 各轨道事件（均带 orig_idx）
    fn parse_dsl_structure(
        &self,
        dsl: &str,
    ) -> (
        Vec<(String, f64, Vec<String>)>,            // 全局事件
        Vec<Vec<(usize, String, f64, Vec<String>)>>, // 轨道事件：(orig_idx, typ, beat, params)
    ) {
        let mut global_events = Vec::new();
        let mut tracks_events = Vec::new();

        // 事件正则表
        let patterns = [
            (r#"\[([a-z]#?\d+),(\d+\.\d+),(\d+),ch(\d+)\]"#, "note_on"),
            (r#"\[\~([a-z]#?\d+),(\d+\.\d+),ch(\d+)\]"#, "note_off"),
            (r#"\[cc,(\d+),(\d+\.\d+),(\d+),ch(\d+)\]"#, "cc"),
            (r#"\[pb,(\d+\.\d+),(-?\d+),ch(\d+)\]"#, "pb"),
            (r#"\[at,(\d+\.\d+),(\d+),ch(\d+),([a-z]#?\d+)\]"#, "at"),
            (r#"\[atc,(\d+\.\d+),(\d+),ch(\d+)\]"#, "atc"),
            (r#"\[text,(\d+\.\d+),"([^"]+)"\]"#, "text"),
            (r#"\[lyric,(\d+\.\d+),"([^"]+)"\]"#, "lyric"),
            (r#"\[marker,(\d+\.\d+),"([^"]+)"\]"#, "marker"),
        ];

        for line in dsl.lines() {
            if line.starts_with("Timeline:") {
                self.parse_timeline_events(line, &mut global_events);
            } else if line.starts_with("Track") {
                let mut track_events = Vec::new();
                for (pattern, typ) in &patterns {
                    if let Ok(re) = regex::Regex::new(pattern) {
                        // 同一行内按出现顺序给序号
                        for (idx, cap) in re.captures_iter(line).enumerate() {
                            let beat = cap[2].parse::<f64>().unwrap();
                            let params: Vec<String> = cap
                                .iter()
                                .skip(1)
                                .filter_map(|m| m.map(|s| s.as_str().to_string()))
                                .collect();
                            track_events.push((idx, typ.to_string(), beat, params));
                        }
                    }
                }
                tracks_events.push(track_events);
            }
        }
        (global_events, tracks_events)
    }
    
    /// 解析时间线事件
    fn parse_timeline_events(&self, timeline_line: &str, events: &mut Vec<(String, f64, Vec<String>)>) {
        // 提取时间区间
        let interval_re = regex::Regex::new(r"\[(\d+)-(\d+)\](\d+)\|([^|]+)\|TPB(\d+)").unwrap();
        
        for cap in interval_re.captures_iter(timeline_line) {
            let start_tick: u32 = cap[1].parse().unwrap();
            let bpm: u32 = cap[3].parse().unwrap();
            let time_sig = &cap[4];
            
            // 创建tempo事件
            let tempo_us = (60_000_000 / bpm) as u32;
            events.push(("tempo".to_string(), start_tick as f64, 
                vec![tempo_us.to_string()]));
            
            // 创建time signature事件
            let ts_parts: Vec<&str> = time_sig.split('/').collect();
            if ts_parts.len() >= 2 {
                let numerator: u8 = ts_parts[0].parse().unwrap_or(4);
                let denominator: u8 = ts_parts[1].parse().unwrap_or(4);
                events.push(("time_sig".to_string(), start_tick as f64,
                    vec![numerator.to_string(), denominator.to_string(), "24".to_string(), "8".to_string()]));
            }
        }
    }
    
    /// 从时间线提取TPB
    fn extract_tpb_from_timeline(&self, dsl: &str) -> Option<u16> {
        let tpb_re = regex::Regex::new(r"TPB(\d+)").unwrap();
        if let Some(cap) = tpb_re.captures(dsl) {
            cap[1].parse().ok()
        } else {
            None
        }
    }
    
    /// 构建指挥轨道（元数据轨道）
    fn build_conductor_track(&self, global_events: &[(String, f64, Vec<String>)], tpb: f64) -> Vec<TrackEvent> {
        let mut events = Vec::new();
        
        // 添加轨道名
        events.push(TrackEvent {
            delta_time: 0,
            event_type: MidiEventType::TrackName("Conductor Track".to_string()),
        });
        
        // 按时间排序
        let mut sorted_events: Vec<(u32, &(String, f64, Vec<String>))> = global_events
            .iter()
            .map(|ev| ((ev.1 * tpb) as u32, ev))
            .collect();
        sorted_events.sort_by_key(|(tick, _)| *tick);
        
        // 添加事件
        let mut last_tick = 0;
        for (tick, (typ, _, params)) in sorted_events {
            let delta = tick.saturating_sub(last_tick);
            last_tick = tick;
            
            let event = match typ.as_str() {
                "tempo" => {
                    let tempo: u32 = params[0].parse().unwrap();
                    MidiEventType::Tempo(tempo)
                }
                "time_sig" => {
                    let numerator: u8 = params[0].parse().unwrap_or(4);
                    let denominator: u8 = params[1].parse().unwrap_or(4);
                    let clocks_per_click: u8 = params.get(2).and_then(|s| s.parse().ok()).unwrap_or(24);
                    let thirty_seconds_per_quarter: u8 = params.get(3).and_then(|s| s.parse().ok()).unwrap_or(8);
                    
                    MidiEventType::TimeSignature {
                        numerator,
                        denominator,
                        clocks_per_click,
                        thirty_seconds_per_quarter,
                    }
                }
                _ => continue,
            };
            
            events.push(TrackEvent {
                delta_time: delta,
                event_type: event,
            });
        }
        
        events
    }
    

    /// DSL验证内部实现 - 增强时序检查
    fn validate_dsl_internal(&self, dsl: &str) -> Vec<String> {
        let mut errors = Vec::new();

        // 1. Timeline 必须且只能出现一次
        let timeline_count = dsl.matches("Timeline:").count();
        if timeline_count != 1 {
            errors.push(format!("Timeline 必须且只能出现一次，当前出现 {} 次", timeline_count));
        }

        // 2. 检查时间顺序 - 增强版：检查音符配对
        self.check_note_pairing(dsl, &mut errors);

        // 3. 轨道级分离检查（人声/旋律强制分离）
        self.check_vocal_melody_separation(dsl, &mut errors);

        // 4. 检查参数范围
        self.check_parameter_ranges(dsl, &mut errors);

        // 5. 检查事件语法
        self.check_event_syntax(dsl, &mut errors);

        errors
    }
    
    /// 检查音符配对和时间顺序
    fn check_note_pairing(&self, dsl: &str, errors: &mut Vec<String>) {
        // 按轨道检查
        for (line_num, line) in dsl.lines().enumerate() {
            if line.starts_with("Track") {
                // 提取轨道中的所有音符事件
                let note_starts: Vec<(String, f64, String)> = self.extract_note_events(line, "note_on");
                let note_ends: Vec<(String, f64, String)> = self.extract_note_events(line, "note_off");
                
                // 按音符名和通道分组
                let mut notes_by_name_channel: HashMap<(String, String), Vec<(bool, f64)>> = HashMap::new();
                
                // 收集开始事件
                for (note_name, beat, channel) in note_starts {
                    notes_by_name_channel
                        .entry((note_name.clone(), channel.clone()))
                        .or_insert_with(Vec::new)
                        .push((true, beat));
                }
                
                // 收集结束事件
                for (note_name, beat, channel) in note_ends {
                    notes_by_name_channel
                        .entry((note_name.clone(), channel.clone()))
                        .or_insert_with(Vec::new)
                        .push((false, beat));
                }
                
                // 检查每个音符的时序
                for ((note_name, channel), mut events) in notes_by_name_channel {
                    // 按时间排序
                    events.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
                    
                    let mut stack: Vec<f64> = Vec::new(); // 存储开始时间
                    
                    for (is_start, beat) in events {
                        if is_start {
                            // 开始事件入栈
                            stack.push(beat);
                        } else {
                            // 结束事件
                            if let Some(start_beat) = stack.pop() {
                                if beat <= start_beat {
                                    errors.push(format!(
                                        "Track{} Line {}: 音符结束时间必须大于开始时间 ({} {}: {} <= {})",
                                        line.split(':').next().unwrap_or(""),
                                        line_num + 1,
                                        note_name,
                                        channel,
                                        beat,
                                        start_beat
                                    ));
                                }
                            } else {
                                errors.push(format!(
                                    "Track{} Line {}: 音符没有对应的开始事件 ({} {})",
                                    line.split(':').next().unwrap_or(""),
                                    line_num + 1,
                                    note_name,
                                    channel
                                ));
                            }
                        }
                    }
                    
                    // 检查未结束的音符
                    for start_beat in stack {
                        errors.push(format!(
                            "Track{} Line {}: 音符没有结束事件 ({} {} 开始于: {})",
                            line.split(':').next().unwrap_or(""),
                            line_num + 1,
                            note_name,
                            channel,
                            start_beat
                        ));
                    }
                }
            }
        }
    }
    
    /// 提取音符事件
    fn extract_note_events(&self, line: &str, event_type: &str) -> Vec<(String, f64, String)> {
        let mut events = Vec::new();
        
        let pattern = match event_type {
            "note_on" => r"\[([a-z]#?\d+),(\d+\.\d+),\d+,ch(\d+)\]",
            "note_off" => r"\[\~([a-z]#?\d+),(\d+\.\d+),ch(\d+)\]",
            _ => return events,
        };
        
        if let Ok(re) = regex::Regex::new(pattern) {
            for cap in re.captures_iter(line) {
                let note_name = cap[1].to_string();
                let beat: f64 = cap[2].parse().unwrap_or(0.0);
                let channel = format!("ch{}", cap[3].to_string());
                
                events.push((note_name, beat, channel));
            }
        }
        
        events
    }

   /// DSL 事件 → MIDI 事件（轨道内 FIFO，NoteOff 独立输出）
fn convert_dsl_events_to_midi(
    &self,
    dsl_events: &[(usize, String, f64, Vec<String>)], // (orig_idx, typ, beat, params)
    tpb: f64,
    _track_idx: usize,
) -> Vec<TrackEvent> {
    use MidiEventType::{NoteOff, NoteOn};

    // 1. 按 (beat, orig_idx) 排序
    let mut sorted = dsl_events.to_vec();
    sorted.sort_by(|a, b| {
        let t = a.2.partial_cmp(&b.2).unwrap_or(Ordering::Equal);
        if t != Ordering::Equal { t } else { a.0.cmp(&b.0) }
    });

    // 2. 每个 (note, ch) 一个 FIFO 队列
    let mut active: std::collections::HashMap<(String, String), VecDeque<(f64, u8)>> = HashMap::new();
    let mut midi: Vec<(u32, MidiEventType)> = Vec::new();

    for (_ord, typ, beat, params) in sorted {
        let tick = (beat * tpb).round() as u32;
        match typ.as_str() {
            "note_on" => {
                let note = &params[0];
                let ch   = &params[3];
                let vel: u8 = params[2].parse().unwrap_or(100);
                active.entry((note.clone(), ch.clone()))
                      .or_insert_with(VecDeque::new)
                      .push_back((beat, vel));
            }
            "note_off" => {
                let note = &params[0];
                let ch   = &params[2];
                if let Some(deq) = active.get_mut(&(note.clone(), ch.clone())) {
                    if let Some((start_beat, vel)) = deq.pop_front() {
                        let start_tick = (start_beat * tpb).round() as u32;
                        let ch_num: u8 = ch.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
                        let key = name_to_midi(note);
                        // NoteOn
                        midi.push((start_tick, NoteOn { channel: ch_num, note: key, velocity: vel }));
                        // NoteOff 独立事件
                        midi.push((tick,      NoteOff { channel: ch_num, note: key }));
                    }
                }
            }
            _ => { // 其余事件
                if let Some(e) = self.convert_other_event(typ, tick, &params) {
                    midi.push((tick, e));
                }
            }
        }
    }

    // 3. 未闭合音符默认 4 拍后结束
    for ((note, ch), deq) in active {
        let ch_num: u8 = ch.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
        let key = name_to_midi(&note);
        for (start_beat, vel) in deq {
            let start_tick = (start_beat * tpb).round() as u32;
            let end_tick   = start_tick + (4.0 * tpb).round() as u32;
            midi.push((start_tick, NoteOn { channel: ch_num, note: key, velocity: vel }));
            midi.push((end_tick,   NoteOff { channel: ch_num, note: key }));
        }
    }

    midi.sort_by_key(|(t, _)| *t);

    // 4. 生成 TrackEvent
    let mut track = vec![TrackEvent {
        delta_time: 0,
        event_type: MidiEventType::TrackName("Track 0".to_string()),
    }];
    let mut last_tick = 0;
    for (abs, evt) in midi {
        let delta = abs.saturating_sub(last_tick);
        last_tick = abs;
        track.push(TrackEvent { delta_time: delta, event_type: evt });
    }
    track
}
    
    /// 新的音符配对逻辑：按音符名和通道分组
    fn process_note_pairing_with_grouping(
        &self,
        note_events: &[(u32, bool, String, Vec<String>)],
    ) -> Vec<(u32, MidiEventType)> {
        use MidiEventType::{NoteOn, NoteOff};
        
        let mut grouped_events: HashMap<(String, String), Vec<(u32, bool, u8)>> = HashMap::new();
        let mut result = Vec::new();
        
        // 1. 按音符名和通道分组
        for (tick, is_on, _typ, params) in note_events {
            let note_name = if *is_on {
                params[0].clone()
            } else {
                params[0].clone()
            };
            
            let channel = if *is_on {
                params[3].clone()
            } else {
                params[2].clone()
            };
            
            let velocity = if *is_on {
                params[2].parse().unwrap_or(100)
            } else {
                0
            };
            
            grouped_events
                .entry((note_name, channel))
                .or_insert_with(Vec::new)
                .push((*tick, *is_on, velocity));
        }
        
        // 2. 对每个音符进行配对
        for ((note_name, channel), mut events) in grouped_events {
            // 按时间排序
            events.sort_by_key(|(tick, _, _)| *tick);
            
            let mut note_stack: Vec<(u32, u8)> = Vec::new();  // (start_tick, velocity)
            
            for (tick, is_on, velocity) in events {
                if is_on {
                    // NoteOn 事件入栈
                    note_stack.push((tick, velocity));
                } else {
                    // NoteOff 事件：与最近的未结束的NoteOn配对
                    if let Some((start_tick, velocity)) = note_stack.pop() {
                        let channel_num: u8 = channel.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
                        let midi_note = name_to_midi(&note_name);
                        
                        // 只添加时间有效的音符
                        if tick > start_tick {
                            result.push((start_tick, NoteOn {
                                channel: channel_num,
                                note: midi_note,
                                velocity,
                            }));
                            
                            result.push((tick, NoteOff {
                                channel: channel_num,
                                note: midi_note,
                            }));
                        }
                    }
                }
            }
            
            // 处理未结束的音符（添加默认结束）
            for (start_tick, velocity) in note_stack {
                let channel_num: u8 = channel.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
                let midi_note = name_to_midi(&note_name);
                let end_tick = start_tick + (4.0 * 480.0) as u32; // 默认4拍后结束
                
                result.push((start_tick, NoteOn {
                    channel: channel_num,
                    note: midi_note,
                    velocity,
                }));
                
                result.push((end_tick, NoteOff {
                    channel: channel_num,
                    note: midi_note,
                }));
            }
        }
        
        result
    }
    
    /// 转换其他类型的事件
    fn convert_other_event(&self, typ: String, _tick: u32, params: &[String]) -> Option<MidiEventType> {
        match typ.as_str() {
            "cc" => {
                let controller: u8 = params[0].parse().unwrap_or(0);
                let value: u8 = params[2].parse().unwrap_or(0);
                let channel_str = &params[3];
                let channel: u8 = channel_str.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
                
                Some(MidiEventType::Controller {
                    channel,
                    controller,
                    value,
                })
            }
            "pb" => {
                let value: i32 = params[1].parse().unwrap_or(0);
                let channel_str = &params[2];
                let channel: u8 = channel_str.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
                
                Some(MidiEventType::PitchBend {
                    channel,
                    value: value as i16,
                })
            }
            "at" => {
                let pressure: u8 = params[1].parse().unwrap_or(0);
                let channel_str = &params[2];
                let channel: u8 = channel_str.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
                let note_name = &params[3];
                let note = name_to_midi(note_name);
                
                Some(MidiEventType::Aftertouch {
                    channel,
                    note,
                    pressure,
                })
            }
            "atc" => {
                let pressure: u8 = params[1].parse().unwrap_or(0);
                let channel_str = &params[2];
                let channel: u8 = channel_str.strip_prefix("ch").unwrap_or("0").parse().unwrap_or(0);
                
                Some(MidiEventType::ChannelAftertouch {
                    channel,
                    pressure,
                })
            }
            "text" => {
                let text = params[1].clone();
                Some(MidiEventType::Text(text))
            }
            "lyric" => {
                let text = params[1].clone();
                Some(MidiEventType::Lyric(text))
            }
            "marker" => {
                let text = params[1].clone();
                Some(MidiEventType::Marker(text))
            }
            _ => None,
        }
    }
    
    /// 检查人声/旋律分离
    fn check_vocal_melody_separation(&self, dsl: &str, errors: &mut Vec<String>) {
        let track_re = regex::Regex::new(r"Track(\d+): (.+)").unwrap();
        let lyric_re = regex::Regex::new(r"\[lyric,").unwrap();
        let note_re = regex::Regex::new(r"\[[a-z]#?\d+,\d+\.\d+,\d+,ch\d+\]").unwrap();
        
        for cap in track_re.captures_iter(dsl) {
            let track_idx = &cap[1];
            let track_content = &cap[2];
            
            let has_lyric = lyric_re.is_match(track_content);
            let has_note = note_re.is_match(track_content);
            
            // 核心规则：Lyric 轨道禁止包含音符事件
            if has_lyric && has_note {
                errors.push(format!(
                    "Track{}: 歌词轨道禁止包含音符事件（人声和旋律必须分离）",
                    track_idx
                ));
            }
        }
    }
    
    /// 检查参数范围
    fn check_parameter_ranges(&self, dsl: &str, errors: &mut Vec<String>) {
        let track_re = regex::Regex::new(r"Track(\d+): (.+)").unwrap();
        
        for cap in track_re.captures_iter(dsl) {
            let track_idx = &cap[1];
            let track_content = &cap[2];
            
            // 检查力度范围 (0-127)
            for vel_cap in regex::Regex::new(r",ch\d+,(\d+)\]")
                .unwrap()
                .captures_iter(track_content)
            {
                if let Ok(vel) = vel_cap[1].parse::<u8>() {
                    if vel > 127 {
                        errors.push(format!("Track{}: 力度越界: {}", track_idx, vel));
                    }
                }
            }
            
            // 检查 Pitch Bend 范围 (-8192~8191)
            for pb_cap in regex::Regex::new(r"\[pb,\d+\.\d+,(-?\d+),")
                .unwrap()
                .captures_iter(track_content)
            {
                if let Ok(pb_val) = pb_cap[1].parse::<i32>() {
                    if pb_val < -8192 || pb_val > 8191 {
                        errors.push(format!("Track{}: Pitch Bend 值越界: {}", track_idx, pb_val));
                    }
                }
            }
            
            // 检查音高范围 (0-127)
            for note_cap in regex::Regex::new(r"\[([a-z]#?\d+)").unwrap()
                .captures_iter(track_content)
            {
                let note_name = &note_cap[1];
                let midi_note = name_to_midi(note_name);
                if midi_note > 127 {
                    errors.push(format!("Track{}: 音高越界: {}", track_idx, note_name));
                }
            }
        }
    }
    
        /// 检查事件语法
    fn check_event_syntax(&self, dsl: &str, errors: &mut Vec<String>) {
        let valid_event_patterns = [
            r"\[[a-z]#?\d+,\d+\.\d+,\d+,ch\d+\]",
            r"\[\~[a-z]#?\d+,\d+\.\d+,ch\d+\]",
            r"\[cc,\d+,\d+\.\d+,\d+,ch\d+\]",
            r"\[pb,\d+\.\d+,-?\d+,ch\d+\]",
            r"\[at,\d+\.\d+,\d+,ch\d+,[a-z]#?\d+\]",
            r"\[atc,\d+\.\d+,\d+,ch\d+\]",
            r#"\[text,\d+\.\d+,"[^"]*"\]"#,
            r#"\[lyric,\d+\.\d+,"[^"]*"\]"#,
            r#"\[marker,\d+\.\d+,"[^"]*"\]"#,
        ];
        
        // 创建正则表达式
        let mut patterns = Vec::new();
        for pattern in valid_event_patterns.iter() {
            if let Ok(re) = regex::Regex::new(pattern) {
                patterns.push(re);
            }
        }
        
        // 检查每个轨道的事件
        for (line_num, line) in dsl.lines().enumerate() {
            if line.starts_with("Track") {
                if let Some(events_part) = line.splitn(2, ':').nth(1) {
                    for event in events_part.split_whitespace() {
                        let mut matched = false;
                        for pattern in &patterns {
                            if pattern.is_match(event) {
                                matched = true;
                                break;
                            }
                        }
                        if !matched && !event.is_empty() {
                            errors.push(format!("Line {}: 无效的事件语法: {}", line_num + 1, event));
                        }
                    }
                }
            }
        }
    }
}

// ==================== 辅助函数 ====================

/// MIDI 音高 → 音名
fn midi_to_name(pitch: u8) -> String {
    let octave = (pitch as i32 / 12) - 1;
    let name = NOTE_NAMES[(pitch % 12) as usize];
    format!("{}{}", name, octave)
}

/// 音名 → MIDI 音高
fn name_to_midi(name: &str) -> u8 {
    // 分离音名和八度
    if name.len() < 2 {
        return 60; // 默认返回C4
    }
    
    // 找到音名和八度的分界点
    let mut note_end = 0;
    for (i, ch) in name.char_indices() {
        if ch.is_ascii_digit() {
            note_end = i;
            break;
        }
    }
    
    if note_end == 0 {
        return 60; // 默认返回C4
    }
    
    let note_part = &name[..note_end];
    let octave_part = &name[note_end..];
    
    let octave: i32 = octave_part.parse().unwrap_or(4);
    
    // 查找音名索引
    let note_index = NOTE_NAMES.iter()
        .position(|&n| n == note_part)
        .unwrap_or(0);
    
    ((octave + 1) * 12 + note_index as i32) as u8
}

// ==================== 测试函数 ====================

/// 快速测试函数
#[napi]
pub fn test_quantize(midi_data: Buffer) -> Result<String> {
    let quantizer = MidiQuantizer::new();
    quantizer.quantize(midi_data)
}

/// 快速测试生成函数
#[napi]
pub fn test_generate(dsl: String) -> Result<Buffer> {
    let quantizer = MidiQuantizer::new();
    quantizer.generate(dsl)
}

/// 验证并返回错误详情
#[napi]
pub fn validate_with_errors(dsl: String) -> Vec<String> {
    let quantizer = MidiQuantizer::new();
    quantizer.validate_dsl_internal(&dsl)
}

/// 综合测试：双向转换验证
#[napi]
pub fn roundtrip_test(midi_data: Buffer) -> Result<String> {
    let quantizer = MidiQuantizer::new();
    
    // 1. MIDI -> DSL
    let dsl = quantizer.quantize(midi_data)?;
    
    // 2. DSL -> MIDI
    let generated_midi = quantizer.generate(dsl.clone())?;
    
    // 3. 验证生成的MIDI
    let generated_dsl = quantizer.quantize(generated_midi)?;
    
    // 比较两个DSL
    let original_lines: Vec<&str> = dsl.lines().collect();
    let generated_lines: Vec<&str> = generated_dsl.lines().collect();
    
    let mut result = String::new();
    result.push_str("=== 双向转换测试结果 ===\n");
    result.push_str(&format!("原始DSL行数: {}\n", original_lines.len()));
    result.push_str(&format!("生成DSL行数: {}\n", generated_lines.len()));
    
    // 简单比较
    if original_lines.len() == generated_lines.len() {
        result.push_str("✓ 行数匹配\n");
        
        let mut mismatches = 0;
        for (i, (orig, gen)) in original_lines.iter().zip(generated_lines.iter()).enumerate() {
            if orig != gen {
                mismatches += 1;
                result.push_str(&format!("第{}行不匹配:\n", i+1));
                result.push_str(&format!("  原始: {}\n", orig));
                result.push_str(&format!("  生成: {}\n", gen));
            }
        }
        
        if mismatches == 0 {
            result.push_str("✓ 所有行完全匹配\n");
        } else {
            result.push_str(&format!("⚠ 有{}行不匹配\n", mismatches));
        }
    } else {
        result.push_str("✗ 行数不匹配\n");
    }
    
    Ok(result)
}