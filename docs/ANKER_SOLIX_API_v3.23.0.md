# Anker SOLIX Cloud API Reference

```yaml
api_reference:
  product: Anker SOLIX App (com.anker.charging)
  app_version: "3.23.0"
  app_release_date: "2026-08-21"
  extraction_method: "string dump of libapp.so (Flutter AOT) from split_config.arm64_v8a.apk"
  server_regions:
    eu: https://ankerpower-api-eu.anker.com        # EU accounts (GDPR, APISIX gateway)
    com: https://ankerpower-api.anker.com          # rest of world
    cn: https://aiot-api-cn.anker.com.cn           # Mainland China (separate app build)
  staging:
    - https://ankerpower-api-qa.anker.com
    - https://ankerpower-api-qa2.anker.com
    - https://ankerpower-api-beta.anker.com
    - https://ankerpower-api-eu-qa.anker.com
    - https://ankerpower-api-eu-qa2.anker.com
    - https://ankerpower-api-eu-beta.anker.com
  protocol: "HTTPS + JSON (POST only)"
  realtime: "MQTT via akiot.mqtt.* provisioning endpoints"
  account_model: "one active session token per account; region pinned at registration"
  confidence_levels: [verified_community, binary_extracted, inferred_from_name]
```

> **How to read this document.** Every endpoint below was extracted from the 3.23.0
> app binary (`libapp.so` string table). Descriptions marked *(inferred)* are derived
> from the endpoint name and app context only — the request/response schema was NOT
> captured and must be verified against a live device (e.g. via mitmproxy) before use.
> Endpoints used by the community Python library `anker-solix-api`
> (github.com/thomluther/anker-solix-api) are marked *(community-verified)*.

---

## 1. Conventions

- **Every call is `POST`** `{region_server}{path}` with `Content-Type: application/json`.
- **Auth header** on all calls after login: `x-auth-token: <auth_token>`;
  client identity header: `appName: anker_power` (both literals verified in the binary).
- **Region matters.** An account registered in the EU must talk to the EU server;
  querying the wrong region returns an empty device list.
- **Response envelope** (community-verified):
  ```json
  { "code": 0, "msg": "success!", "data": { ... } }
  ```
  `code != 0` is an error (see §9). HTTP status is usually 200 even for API errors.

### 1.1 Core data model
| Concept | Meaning |
|---|---|
| `site` / "app system" | The logical energy system (house). A site groups devices. Endpoint prefix `site/*`. |
| `device` | A physical unit (Solarbank, Smart Meter, EV charger...). Identified by `device_sn`. |
| `scene` | Live power-flow snapshot of a site (PV, home load, grid, battery). From `get_scen_info`. |
| `scen_info` | Same as scene. |
| `site param` | Device configuration record read/written via `get_site_device_param` / `set_site_device_param`. |
| `device attrs` | Overloaded generic read/write attribute interface (`get_device_attrs` / `set_device_attrs`), ~21 attribute types on Solarbank-class devices. |
| `extender system` | Smart Generator (oil machine) managed as part of a site. |
| `charging mode` | Time/price-based charge schedule entry (TOU plans). |

---

## 2. Authentication

### 2.1 Classic account login *(community-verified)*
`POST /passport/login`

| Field | Notes |
|---|---|
| `email` | account email |
| `password` | **MD5 hex hash** of the plaintext password (fallback: plaintext for old accounts) |
| `appName` | `"anker_power"` |
| `appOsVersion`, `appVersion`, `model`, `os` | client metadata (`os: "android"`) |
| `country` | 2-char ISO code, must match account region |
| `sign` | client signature; community clients omit or use a fixed value |
| `sn` | optional client serial |

Response `data` contains `auth_token` (session token) and `user_id`.
**One active token per account** — a new login invalidates the previous session.

### 2.2 Session headers (all subsequent calls)
```
appName: anker_power
x-auth-token: <auth_token>
Content-Type: application/json
```
The binary also contains a `gtoken` request value; it is set by the official app but
not required by the community library.

### 2.3 OAuth / third-party login *(binary-extracted; flow inferred)*
Introduced/enabled with the 3.18.0 "login experience upgrade" (Google sign-in,
fingerprint login). AWS Cognito/Amplify is the identity provider
(`assets/api_key.txt` in the APK holds the Amplify API key for
`amzn1.application-oa2-client.2ef3126c0fdd42c79faf119627c0e324`,
authz `https://www.amazon.com/ap/oa`, token `https://api.amazon.com/auth/o2/token`).

| Endpoint | Description |
|---|---|
| `POST /openapi/oauth/authorize` *(inferred)* | Start OAuth authorization (redirect to IdP). |
| `POST /openapi/oauth/key/exchange` *(inferred)* | Exchange third-party identity token for an Anker `auth_token`. |
| `POST /openapi/oauth/app_to_app_access` *(inferred)* | App-to-app token handoff (deep-link return). |

Classic `/passport/login` is unaffected and remains the simplest machine-to-machine flow.

### 2.4 Other passport endpoints *(binary-extracted, self-explanatory)*
| Endpoint | Description |
|---|---|
| `POST /passport/logout` | Invalidate session. |
| `POST /passport/register` | Create account. |
| `POST /passport/estimate_domain` | Return the region server for an email/account (region pinning). |
| `POST /passport/third_party_login` | Social login (Google/Apple/WeChat). |
| `POST /passport/external_login` | External identity login. |
| `POST /passport/phone_verification_login` | SMS code login. |
| `POST /passport/phone_verification_code` | Request SMS code. |
| `POST /passport/phone_verification_regist` | Register via SMS. |
| `POST /passport/phone_bind_account` | Bind phone number. |
| `POST /passport/phone_code_list` | List supported phone country codes. |
| `POST /passport/forget_password` / `phone_reset_password` / `change_password` / `set_account_password` | Password flows. |
| `POST /passport/validate_email` / `validate_pass` | Check credentials without session. |
| `POST /passport/get_profile` / `update_profile` | Account profile. |
| `POST /passport/get_user_param` / `update_user_param` | Account-level KV parameters. |
| `POST /passport/get_subscriptions` / `set_subscriptions` / `subscription_configs` | Marketing/newsletter subscriptions. |
| `POST /passport/terminal_id` | Device terminal ID registration. |
| `POST /passport/freeze_account` | Disable account. |
| `POST /passport/discount_desc` | Promo info. |

---

## 3. `power_service/v1/site/*` — site (system) management & live state
The core API for any home-energy integration.

| Endpoint | Description |
|---|---|
| `POST /power_service/v1/site/get_site_list` *(community-verified)* | List all sites of the account. `data` includes `site_id` and device list. |
| `POST /power_service/v1/site/get_scen_info` *(community-verified)* | **Live power scene**: PV power, home load, grid power, battery power/SOC. Primary read for control loops. Key names observed in community: `solar_power`, `solar_array_power`, `to_home_load`, `home_load`, `grid_power` (negative = export), `battery_power` (negative = charging), `battery_soc`. |
| `POST /power_service/v1/site/get_site_detail` *(community-verified)* | Full site detail incl. device list, prices, schedule. |
| `POST /power_service/v1/site/list_user_devices` *(community-verified)* | All devices bound to the site. |
| `POST /power_service/v1/site/get_site_device_param` *(community-verified)* | Read device configuration params for a site. |
| `POST /power_service/v1/site/set_site_device_param` *(community-verified)* | **Write device configuration** (working mode, limits, etc.). Primary control surface. |
| `POST /power_service/v1/site/get_site_rules` | Site rules/permissions. |
| `POST /power_service/v1/site/get_site_price` / `update_site_price` *(community-verified)* | Electricity price settings. |
| `POST /power_service/v1/site/get_schedule` | Scheduled actions for the site. |
| `POST /power_service/v1/site/energy_analysis` *(community-verified)* | Historical energy stats. |
| `POST /power_service/v1/site/get_home_load_chart` | Home consumption chart. |
| `POST /power_service/v1/site/get_power_limit` | Current power limit setting. |
| `POST /power_service/v1/site/create_site` / `update_site` / `delete_site` | Site CRUD. |
| `POST /power_service/v1/site/add_site_devices` / `delete_site_devices` | Bind/unbind devices. |
| `POST /power_service/v1/site/add_charging_device` / `delete_charging_device` / `get_charging_device` / `update_charging_device` / `reset_charging_device` | EV-charger device management within the site. |
| `POST /power_service/v1/site/get_addable_site_list` / `get_comb_addable_sites` / `can_create_site` | Site/device reassignment helpers. |
| `POST /power_service/v1/site/set_device_feature` | Toggle a device feature flag. |
| `POST /power_service/v1/site/shift_power_site_type` | Convert site type. |
| `POST /power_service/v1/site/get_wifi_info_list` / `local_net` | WiFi info / local-network pairing data. |
| `POST /power_service/v1/site/co2_ranking` | CO2 savings ranking (gamification). |
| `POST /power_service/v1/site/site_data_check` / `site_data_exported` | Data-export (GDPR) flow markers. |
| `POST /power_service/v1/set_user_site_param` | User-level site parameter. |
| `POST /power_service/v1/ai_ems/get_status` / `profit` | AI-EMS (energy-management AI) status and earnings. |

## 4. `power_service/v1/app/*` — account-scope app services

### 4.1 Device read/write (generic attribute interface)
| Endpoint | Description |
|---|---|
| `POST /power_service/v1/app/device/get_device_attrs` *(community-verified)* | Generic attribute read. Attribute set depends on device type (~21 attr types for Solarbank-class devices). |
| `POST /power_service/v1/app/device/set_device_attrs` *(community-verified)* | Generic attribute write. **Solarbank 2 control surface** — e.g. manual output power (`output_power`, watts, 0–1600), PV input limit (`pv_limit`). Exact attr names must be verified per firmware (mitmproxy). |
| `POST /power_service/v1/app/device/get_device_home_load` / `set_device_home_load` | Home-load device association. |
| `POST /power_service/v1/app/device/get_device_income` | Per-device earnings info. |
| `POST /power_service/v1/app/device/get_mes_device_info` | Manufacturing info. |
| `POST /power_service/v1/app/device/get_relate_belong` | Ownership relation. |
| `POST /power_service/v1/app/device/remove_param_config_key` | Remove a param key. |
| `POST /power_service/v1/app/devicerelation/*` | `relate_device`, `un_relate_and_unbind_device`, `up_alias_name`, `clear_share` — device binding/renaming/unbinding. |
| `POST /power_service/v1/app/devicemanage/update_relate_device_info` | Update bound device info. |

### 4.2 Site sharing (family members)
| Endpoint | Description |
|---|---|
| `POST /power_service/v1/app/share_site/invite_member` | Invite by email/phone. |
| `POST /power_service/v1/app/share_site/anonymous_join_site` | Join via share code. |
| `POST /power_service/v1/app/share_site/join_site` | Accept invite. |
| `POST /power_service/v1/app/share_site/get_invited_list` | Pending invites. |
| `POST /power_service/v1/app/share_site/delete_inviting_member` / `delete_site_member` | Remove member/invite. |

> NOTE: shared/member accounts have **read-only** device access — they cannot call
> device write endpoints. Relevant for splitting "backend account" vs "app user".

### 4.3 OTA & upgrades
| Endpoint | Description |
|---|---|
| `POST /power_service/v1/app/compatible/get_ota_info` / `get_ota_update` / `set_ota_update` | OTA status/trigger. |
| `POST /power_service/v1/app/check_upgrade_record` / `get_upgrade_record` | Upgrade history. |
| `POST /power_service/v1/app/set_auto_upgrade` / `get_auto_upgrade` | Auto-update toggle. |
| `POST /power_service/v1/app/upgrade_event_report` / `upgrade_event_reports` | Firmware update event reporting. |
| `POST /power_service/v1/app/get_extender_system_pn_ota` | Generator OTA info. |

### 4.4 Generator / extender system (Smart Generator fleet)
| Endpoint | Description |
|---|---|
| `POST /power_service/v1/app/get_extender_system_list` / `get_extender_system_detail` | List/detail of generator systems. |
| `POST /power_service/v1/app/add_extender_system` / `del_extender_system` | Create/remove extender system. |
| `POST /power_service/v1/app/add_extender_system_device_list` / `batch_add_extender_system_device` / `batch_del_extender_system_device` | Device membership. |
| `POST /power_service/v1/app/set_extender_system_name` / `set_extender_system_cumulative_data` / `get_extender_system_cumulative_data` | Naming / lifetime counters. |
| `POST /power_service/v1/app/update_extender_system_strategy` | Generator strategy (start/stop thresholds). |
| `POST /power_service/v1/app/start_oil_machine_exercise` / `switch_exercise_mode` | Manual exercise run of the oil engine. |
| `POST /power_service/v1/app/set_oil_machine_exercise_plan` / `get_device_exercise_details` / `get_device_exercise_log` / `get_device_last_exercise_logs` | Exercise scheduling/logs. |
| `POST /power_service/v1/app/get_parts_maintenance_plan` / `set_parts_maintenance_plan` / `get_parts_maintenance_logs` | Parts maintenance schedules. |
| `POST /power_service/v1/app/set_maintain_parts_notice_switch` / `set_maintain_parts_ignore_reminders` | Maintenance reminders. |
| `POST /power_service/v1/app/set_oil_consumption_reminder_plan` / `get_oil_consumption_reminder_plan_details` / `set_oil_consumption_reminder_switch` | Fuel reminders. |
| `POST /power_service/v1/app/batch_maintain_oil_engine_parts` | Batch parts maintenance. |
| `POST /app/wakeup_oil_machine_bluetooth` *(in `/app` prefix)* | BLE wakeup of the generator. |

### 4.5 Misc app services
| Endpoint | Description |
|---|---|
| `POST /power_service/v1/app/get_relate_and_bind_devices` | All bound devices of account. |
| `POST /power_service/v1/app/get_token_by_userid` | Refresh/obtain service token. |
| `POST /power_service/v1/app/whitelist/feature/check` | Feature-flag (A/B) check. |
| `POST /power_service/v1/app/third/platform/list` | Supported third-party platforms (Tibber, etc.). |
| `POST /power_service/v1/app/get_user_op_shelly_status` | Shelly plug status (smart plugs in site). |
| `POST /power_service/v1/app/shelly_ctrl_device` | Control Shelly-class device. |
| `POST /power_service/v1/app/get_weather` | Weather for the site location. |
| `POST /power_service/v1/app/get_annual_report` | Yearly energy report. |
| `POST /power_service/v1/app/get_monthly_report_configs` / `set_monthly_report_configs` / `mothly_report_list` *(sic)* / `mothly_report_show` | Monthly report (3.12.0+). |
| `POST /power_service/v1/app/report_tlv_event` | Device event reporting (TLV encoded). |
| `POST /power_service/v1/currency/get_list` | Currency list. |
| `POST /power_service/v1/dynamic_price/*` (`check_available`, `price_detail`, `support_option`, `check_adjust`) | Dynamic electricity tariffs (Tibber/Awattar integration). |
| `POST /power_service/v1/everhome/bind` | everhome (energy community) binding. |
| `POST /power_service/v1/product_accessories` / `product_categories` | Shop catalog. |
| `POST /power_service/v1/get_all_service_config` | Aggregated service config. |
| `POST /power_service/v1/ai_ems/*` | see §3. |
| Messages: `add_message`, `get_message`, `get_message_sn_list`, `get_message_unread`, `read_message`, `del_message`, `get_message_not_disturb`, `message_not_disturb` | In-app notification inbox. |
| `POST /power_service/v1/app/help/*` | FAQs, feedback, manuals, banners, terms, app-version check, DST. |
| `POST /power_service/v1/app/logging/get_device_logging` / `upload` / `upload_pb_events` | Diagnostic log upload/download. |
| `POST /power_service/v1/app/after_sale/*` (`check_popup`, `get_popup`, `check_sn`, `mark_sn`) | RMA/after-sales flow. |
| `POST /power_service/v1/app/compatible/*` | Third-party compatibility (solar info, installation, power cutoff, permissions, OTA). |
| `POST /power_service/v1/app/get_brand_list` / `get_model_list` / `get_models` / `get_model_years` | Vehicle DB for EV charging. |
| `POST /power_service/v1/app/get_device_bind_details` | Binding audit info. |
| `POST /power_service/v1/app/user/get_user_params` / `set_user_params` | User KV params. |
| `POST /power_service/v1/app/vehicle/*` | see §8. |

## 5. `power_service/v2/*` — new-generation API surface (3.23.0)
Introduced between 3.8.0 and 3.23.0; likely the primary surface for Solarbank 4 Pro-class devices. All *(inferred)*.

| Endpoint | Description |
|---|---|
| `POST /power_service/v2/site/get_output_power_info` | Current output power info (v2 equivalent of scen_info power fields). |
| `POST /power_service/v2/site/platform_get_site_savings` | Site savings summary. |
| `POST /power_service/v2/device/energy_analysis` | v2 energy analytics. |
| `POST /power_service/v2/device/energy_options` | Available analysis options/intervals. |
| `POST /power_service/v2/device/report_data` | Report/query device telemetry. |
| `POST /power_service/v2/device/timeline/event` | Device event timeline. |
| `POST /power_service/v2/device/timeline/event/batch_read` | Mark timeline events read (batch). |
| `POST /power_service/v2/app/get_hardware_relation` | Hardware topology (meter↔inverter↔battery). |
| `POST /power_service/v2/app/set_device_pv_name` | Name a PV input. |
| `POST /power_service/v2/platform_get_pn_region_code` | Region code for a part number. |
| `POST /power_service/v2/platform_get_user_region_param` / `platform_set_user_region_param` | Region-dependent user params. |

## 6. `charging_hes_svc/*` — X1 Home Energy System (A5101) user API

| Endpoint | Description |
|---|---|
| `POST /charging_hes_svc/start` | HES system start/setup handshake. |
| `POST /charging_hes_svc/get_hes_dev_info` | HES device info. |
| `POST /charging_hes_svc/get_system_running_info` / `get_system_running_time` | Live system state and uptime. |
| `POST /charging_hes_svc/get_device_card_list` / `get_device_card_details` | Home-screen device cards. |
| `POST /charging_hes_svc/device_command` / `get_device_command` | **Device control command channel** (start/stop/mode). |
| `POST /charging_hes_svc/get_energy_statistics` / `download_energy_statistics` / `report_device_data` | Stats. |
| `POST /charging_hes_svc/get_mi_layout` / `get_site_mi_list` | Microinverter layout/list. |
| `POST /charging_hes_svc/restart_peak_session` | Restart peak-shaving (PPS) session. |
| `POST /charging_hes_svc/authorize_aiems` / `enable_aiems_mode` / `get_aiems_profit` / `get_system_profit_detail` | AI-EMS authorization/mode/profit. |
| `POST /charging_hes_svc/update_hes_utility_rate_plan` / `get_tou_price_plan_detail` / `get_utility_rate_plans` / `adjust_station_price_unit` / `get_world_monetary_unit` | Tariff / TOU plans. |
| Disaster prep (storm guard): `get_auto_disaster_prepare_status`, `get_auto_disaster_prepare_detail`, `quit_auto_disaster_prepare`, `get_current_disaster_prepare_details`, `get_back_up_history`, `sync_back_up_history` | Backup/disaster-preparedness history & status. |
| EV chargers in station: `get_station_evchargers`, `set_station_evchargers`, `get_user_bind_and_not_in_station_evchargers` | EV-charger↔station association. |
| Installer/commissioning: `get_install_info`, `get_installer_info`, `get_station_config_and_status`, `get_device_pn_info`, `get_device_product_info`, `update_device_info_by_app` | Setup flows. |
| Connectivity: `get_wifi_info`, `update_wifi_config`, `get_conn_net_tips`, `get_system_device_time` | WiFi and clock. |
| Faults: `user_fault_alarm`, `get_user_fault_info`, `remove_user_fault_info`, `user_event_alarm` | Alarm inbox. |
| VPP: `get_vpp_check_code`, `get_vpp_service_policy_by_agg_user` | Virtual power plant enrollment. |
| `POST /charging_hes_svc/device_self_check` / `get_device_self_check` | Device self-check. |
| `POST /charging_hes_svc/check_update` / `ota` | Firmware update. |
| `POST /charging_hes_svc/check_device_bluetooth_password` | BLE pairing password. |
| `POST /charging_hes_svc/deal_share_data` / `cancel_pop` | Sharing/popups. |
| `POST /charging_hes_svc/get_external_device_config` / `get_heat_pump_plan_json` | External device (heat pump) configs. |
| `POST /charging_hes_svc/get_history_setting` | Settings history. |
| `POST /charging_hes_svc/check_function` | Feature availability check. |
| `POST /charging_hes_svc/upload_device_status` | Device status upload. |

## 7. `charging_hes_installer_svc/*` — X1 installer portal (3.23.0, new)
Separate authenticated surface for professional installers; has its **own login** (`passport_login`).

| Endpoint | Description |
|---|---|
| `POST /charging_hes_installer_svc/passport_login` | Installer login. |
| `POST /charging_hes_installer_svc/check_function` | Feature check. |
| `POST /charging_hes_installer_svc/authorize_aiems` / `enable_aiems_mode` / `edit_system_strategy` / `get_system_strategy` / `get_history_setting` | AI-EMS & system strategy management. |
| `POST /charging_hes_installer_svc/get_utility_rate_plans` / `get_price` / `get_price_company` / `save_dynamic_price` / `save_time_of_use` / `adjust_station_price_unit` / `get_world_monetary_unit` / `get_area_by_code` / `get_third_jump_url` | Tariff configuration for customers. |
| `POST /charging_hes_installer_svc/v2/app/third/platform/list` | Third-party platforms (v2). |
| `POST /charging_hes_installer_svc/v2/ota/batch/check_update` | Batch OTA check. |
| `POST /charging_hes_installer_svc/v2/ota/{deviceSn}/{component}/update/{version}` | Targeted OTA update per component. |

## 8. EV charging services (V1 Smart EV Charger, 3.23.0)

| Endpoint | Description |
|---|---|
| `POST /power_service/v1/app/vehicle/add_vehicle` / `get_vehicle_list` / `get_vehicle_detail` / `update_vehicle` / `delete_vehicle` / `set_default` / `set_charging_vehicle` | Vehicle garage (brand/model DB via `get_brand_list`/`get_model_list`). |
| `POST /app/order/get_charging_order_list` / `get_charging_order_detail` / `get_charging_order_sec_detail` / `get_charging_order_sec_preview` / `delete_charging_order` / `export_charge_order` / `get_charge_order_stats` / `get_charge_order_stats_list` | Charging-session orders, billing export, statistics. |
| `POST /app/get_ocpp_info` / `get_ocpp_endpoint_list` | OCPP (open charge protocol) info/endpoints. |
| `POST /app/get_self_check_record` / `self_check_report` | Charger self-check. |
| `POST /app/vehicle/*` (non-`power_service` variants) | Mirrors of the vehicle API under the `/app` prefix. |

## 9. `charging_energy_service/*` — A17B1 Power Panel

| Endpoint | Description |
|---|---|
| `POST /charging_energy_service/get_configs` / `sync_config` | Panel configuration. |
| `POST /charging_energy_service/get_device_infos` / `get_sns` / `get_rom_versions` | Device inventory/versions. |
| `POST /charging_energy_service/get_system_running_info` / `get_error_infos` / `report_device_data` | Live state / errors / telemetry. |
| `POST /charging_energy_service/energy_statistics` | Energy stats. |
| `POST /charging_energy_service/restart_peak_session` | Peak-shaving session restart. |
| `POST /charging_energy_service/get_utility_rate_plan` / `ack_utility_rate_plan` / `preprocess_utility_rate_plan` / `get_world_monetary_unit` / `adjust_station_price_unit` | Tariff plans. |
| `POST /charging_energy_service/get_installation_inspection` / `sync_installation_inspection` | Installation inspection records. |
| `POST /charging_energy_service/get_wifi_info` | WiFi config. |

## 10. `charging_hes_dynamic_price_svc/*` — dynamic tariffs (Tibber etc.)

`get_price`, `get_price_company`, `save_dynamic_price`, `save_time_of_use`, `get_area_by_code`, `get_third_jump_url` — dynamic price provider configuration; `get_third_jump_url` deep-links to provider OAuth (e.g. Tibber).

## 11. `charging_hes_third_party_service_svc/*` — third-party EMS integration

| Endpoint | Description |
|---|---|
| `POST /charging_hes_third_party_service_svc/query_modbus_setting` | Read Modbus/TCP settings for external EMS. |
| `POST /charging_hes_third_party_service_svc/set_modbus_setting` | Write Modbus settings. |

## 12. `charging_pv_svc/*` — A5140 solar device

`getPvStatus`, `getPvTotalStatistics`, `statisticsPv`, `getMiStatus`, `set_aps_power` (APS power setpoint), `selectUserTieredElecPrice`, `updateUserTieredElecPrice`.

## 13. `charging_disaster_prepared/*` — storm/backup guard

`get_site_device_disaster`, `get_site_device_disaster_status`, `set_site_device_disaster`, `quit_disaster_prepare`, `get_support_func`, `clear`, `disaster_detail/ankerWeather.html` (weather info page).

## 14. `charging_common_svc/*` — location services

`location/get`, `location/set`, `location/support` — site GPS location (for weather/solar estimates).

## 15. `charging_imsg_svc/*` — messaging/referrals

`app/referral/get_red`, `app/referral/del_red` — referral/red-envelope (regional promo).

## 16. `mini_power/v1/app/*` — prime power banks (A2345, A2687, 26K/20K)

| Group | Endpoints |
|---|---|
| Charging schedules | `charging/add_charging_mode`, `delete_charging_mode`, `get_charging_mode_list`, `update_charging_mode`; `setting/set_charging_mode_status` |
| Power data | `power/get_day_power_data` |
| Settings | `setting/get_device_setting`, `set_protocol_status`/`get_protocol_status`, `set_port_protocol_status`/`get_port_protocol_status`, `set_power_range_support_protocols`, `set_port_remark`/`get_port_remarks`, `set_compatibility_status`, `set_mode_sub_status`, `set_user_last_location`/`get_user_last_location`, device-identity status getters/setters |
| Reminders | `reminder/set_reminder`, `get_reminder_list`, `del_reminder` |
| Style | `style/get_clock_screensavers`, `get_manual_clock_screensavers`, `add_manual_clock_screensavers`, `delete_manual_clock_screensavers`, `set_manual_clock_screensaver_name`, `get_screensaver_img_url`, `get_url` |

## 17. `smart_service/v1/app/anka/*` — AI agent "Anka"

`get_question_bank`, `get_entry_config`/`set_entry_switch`/`get_entry_show`, `get_menu_config`, `welcome`/`welcome_cta`, `proactive_cta`, `setting`, `set_memory_switch`, `set_push_switch`, `delete_all_memory`, `POST /app/ai/anka` (inference endpoint).

## 18. `/app/*` (non-`power_service`) — general services

| Endpoint | Description |
|---|---|
| `POST /app/cloudstor/get_app_up_token_general` / `get_app_up_token_without_login` | Cloud-storage upload tokens. |
| `POST /app/cloudstor/get_down_load_urls` | Download URLs. |
| `POST /app/push/register_push_token` / `clear_count` | Push notification registration. |
| `POST /app/logging/get_device_logging` / `upload` / `upload_pb_events` | Logs. |
| `POST /app/ota/batch/check_update` | Batch OTA check. |
| `POST /app/ota/{deviceSn}/{moduleType}/update/{version}` | Targeted OTA update. |
| `POST /app/group/save_group_devices` / `get_group_devices` / `delete_group_devices` / `replace_group_devices` / `force_save_group_devices` | **Device grouping** (e.g. Power Dock groups) *(inferred)*. |
| `POST /app/news/get_popups` / `popup_record` | In-app news popups. |
| `POST /app/referral/entrance_check` | Referral eligibility. |
| `POST /app/share_site_report` | Shared-site report. |
| `POST /app/record_device_command` | Audit log of device commands. |
| `POST /app/get_custom_branch_icon` | Custom UI icon. |
| `POST /app/get_standby_exercise_plan` / `set_standby_exercise_plan` | Standby exercise schedule *(generator)*. |
| `POST /app/user/get_user_params` / `set_user_params` | User KV. |
| `POST /app/help/*`, `POST /app/device/*` | mirrors of §4 services on the `/app` prefix. |

## 19. MQTT real-time channel

The app provisions and uses an MQTT connection for live device push (HES/X1/Power Dock,
Solarbank real-time updates). Full client API in the 3.23.0 binary:

| Endpoint | Description |
|---|---|
| `POST /akiot.mqtt.get_client_id` | Provision MQTT client ID/credentials. |
| `POST /akiot.mqtt.connect_mqtt` | Connect. |
| `POST /akiot.mqtt.disconnect_mqtt` | Disconnect. |
| `POST /akiot.mqtt.get_mqtt_connection_status` | Connection state. |
| `POST /akiot.mqtt.subscribe_topic` / `unsubscribe_topic` | Topic management. |
| `POST /akiot.mqtt.publish_message` | Publish command/message. |

*(Broker host/credentials are returned by `get_client_id`; topic scheme is device-specific —
capture via mitmproxy or consult community MQTT implementations.)*

---

## 20. Solarbank 2 E1600 — practical control recipes *(community-verified unless noted)*

### Read live state
```http
POST /power_service/v1/site/get_scen_info
{"site_id": "<site_id>"}
```
Response `data` keys (community-documented; verify per firmware):
`solar_power`, `solar_array_power`, `to_home_load`, `home_load`,
`grid_power` (+ import / − export), `battery_power` (+ discharge / − charge),
`battery_soc`, plus per-device entries in `device_list`.

### Manual output power (0–1600 W, device clamps; 800 W = German balcony limit)
```http
POST /power_service/v1/app/device/set_device_attrs
{"site_id": "<site_id>", "sn": "<device_sn>", "output_power": <watts>}
```
*(attr key `output_power` — verify exact body for your firmware)*

### PV input limit
```http
POST /power_service/v1/app/device/set_device_attrs
{"site_id": "<site_id>", "sn": "<device_sn>", "pv_limit": <watts>}
```

### Working mode / charge behavior
`POST /power_service/v1/site/set_site_device_param` — mode selection (self-consumption,
TOU scenarios), charge limits, anti-backflow offset. **Payload is firmware-specific;
capture once with mitmproxy by toggling the setting in the app.**

### Anti-backflow (zero export)
Not an API call: configured in device working mode (feed-in limit 0 W with Smart Meter
linked). Enforced locally by the Solarbank, sub-second. Cloud writes only steer setpoints.

---

## 21. Rate limits & error codes

| Code / behavior | Meaning | Handling |
|---|---|---|
| `code: 0` | success | — |
| `code: 10000` / `10003` | generic backend failure / hiccup | retry with backoff (~2 s), a few times |
| HTTP 401/403 | expired/invalid session | re-login (fresh token invalidates other sessions!) |
| throttling | too frequent writes | keep write interval ≥ 10–15 s; only write on meaningful delta (~50 W) |
| empty site list | wrong region server | switch EU ↔ COM |

**Session rule:** exactly one active token per account. Re-login anywhere kicks the
other session.

---

## 22. Version diff 3.8.0 (2025-05) → 3.23.0 (2026-08-21)

- Endpoint prefixes: 250 → **429**.
- New: `/power_service/v2/*` family (16 endpoints).
- New: EV charging (`/app/vehicle`, `/app/order`, OCPP), X1 installer portal
  (`/charging_hes_installer_svc`), generator/extender fleet management, device groups
  (`/app/group`), AI agent Anka API, monthly reports, Modbus third-party EMS.
- OAuth login flow completed: `/openapi/oauth/authorize`, `/openapi/oauth/app_to_app_access`.
- MQTT client API fully surfaced.
- Removed: `/passport/destroy_user` (moved to web privacy flow). Nothing auth-critical.
- Unchanged: `/passport/login`, headers, region pinning, one-token-per-account.

## 23. Verification checklist for implementations

1. Confirm region server (EU accounts: `ankerpower-api-eu.anker.com`).
2. Verify `get_scen_info` key names against one real response.
3. Verify `set_device_attrs` / `set_site_device_param` bodies for your firmware via
   mitmproxy (phone proxy → toggle setting in app → copy JSON).
4. Respect write throttling (≥10–15 s between writes).
5. For Solarbank 4 Pro: implement against `/power_service/v2/*` after capturing real
   payloads — this document's v2 descriptions are name-inferred.
