# -*- coding: utf-8 -*-
# -----------------------------------------------------------------------------
# Celestial Almanac Generation Script
# Author: Gemini (for Professor Lancelot)
# Date: 2025-07-18
# Version: 1.2 (Timezone-aware fix)
#
# Description:
# This script generates a simple JSON database of planetary positions
# relative to the Sun (heliocentric ecliptic coordinates) for the next
# year at 2-hour intervals. It uses the Skyfield library to perform
# the astronomical calculations based on a standard JPL ephemeris.
#
# The output is a single file: 'celestial_database.json'
# -----------------------------------------------------------------------------

import json
# FIX: Import 'timezone' to create timezone-aware datetime objects.
from datetime import datetime, timedelta, timezone

# Skyfield is the core library for astronomical calculations.
# If you don't have it, run: pip install skyfield
from skyfield.api import load

def generate_celestial_database():
    """
    Main function to calculate and save the planetary positions.
    """
    print("{{VarUser}}，正在为您启动星历推演程序...")
    print("正在校准时间，加载JPL星历（如果本地没有，将自动从太空总署下载，请稍候）...")

    # --- Configuration ---
    # Here we define the celestial bodies we are interested in.
    # We use the standard names recognized by Skyfield.
    PLANETS_TO_COMPUTE = [
        'mercury', 'venus', 'earth', 'mars',
        'jupiter barycenter', 'saturn barycenter',
        'uranus barycenter', 'neptune barycenter'
    ]
    # For major planets, using the 'barycenter' is more stable for long-term calculations.

    OUTPUT_FILENAME = 'celestial_database.json'
    TIME_STEP_HOURS = 2
    DURATION_DAYS = 366 # Use 366 to be safe for leap years.

    # --- Initialization ---
    # Load the timescale and the ephemeris (planetary position data).
    # de421.bsp is a standard, compact ephemeris suitable for most applications.
    timescale = load.timescale()
    ephemeris = load('de421.bsp')

    # Define our celestial bodies from the loaded ephemeris
    sun = ephemeris['sun']
    planets = {name: ephemeris[name] for name in PLANETS_TO_COMPUTE}

    # --- Time Calculation ---
    # Set the time range for our calculations.
    # FIX: Use datetime.now(timezone.utc) to get a timezone-aware UTC datetime.
    # This is the modern, correct way to handle this and satisfies Skyfield's requirement.
    time_start_utc = datetime.now(timezone.utc)
    time_end_utc = time_start_utc + timedelta(days=DURATION_DAYS)

    print(f"计算周期已设定：从 {time_start_utc.isoformat()} 开始")
    print(f"至 {time_end_utc.isoformat()} 结束")
    print(f"时间步长：{TIME_STEP_HOURS} 小时")
    print("开始计算每个时间点上行星的日心坐标...")

    # --- Main Calculation Loop ---
    celestial_database = {}
    current_time = time_start_utc

    while current_time <= time_end_utc:
        # Skyfield's Time object is necessary for calculations.
        t = timescale.from_datetime(current_time)
        
        # Use ISO 8601 format for the timestamp key. This is a universal standard.
        # .isoformat() on an aware object now correctly includes the timezone info.
        timestamp_key = current_time.isoformat()
        celestial_database[timestamp_key] = {}

        # For each planet, calculate its position relative to the Sun.
        for name, planet_obj in planets.items():
            # The core calculation: observe the planet from the Sun at time t.
            # .position.au gives us the raw [x, y, z] coordinates in Astronomical Units.
            # These are heliocentric rectangular ecliptic coordinates.
            astrometric = sun.at(t).observe(planet_obj)
            x, y, z = astrometric.position.au
            
            # Clean up the name for the JSON key
            clean_name = name.replace(' barycenter', '')

            celestial_database[timestamp_key][clean_name] = {
                'x_au': round(x, 6), # Rounding to 6 decimal places is plenty of precision.
                'y_au': round(y, 6),
                'z_au': round(z, 6)
            }

        # Move to the next time step.
        current_time += timedelta(hours=TIME_STEP_HOURS)

    # --- Save to File ---
    print(f"\n计算完成！共计 {len(celestial_database)} 个时间戳的数据。")
    print(f"正在将宇宙的节律写入您的私人秘典：'{OUTPUT_FILENAME}'...")

    try:
        with open(OUTPUT_FILENAME, 'w', encoding='utf-8') as f:
            # Use indent=2 for a more compact but still readable file.
            json.dump(celestial_database, f, ensure_ascii=False, indent=2)
        print("\n操作成功！")
        print(f"'{OUTPUT_FILENAME}' 已在脚本所在目录生成。")
        print("现在，您可以将这份星辰之力整合进您的塔罗牌占卜系统中了。")
    except IOError as e:
        print(f"\n错误：无法写入文件！请检查权限。错误信息：{e}")

# --- Script Execution ---
if __name__ == '__main__':
    generate_celestial_database()
