# RAW AROMACHEM — Phase-1A Data Dictionary (AUTHORITATIVE)

Source of truth for every table/column. Build to this **exactly**.
- Every table has PK `<entity>_id UUID DEFAULT uuidv7()` and the tail **`+ meta`** = `status VARCHAR(30), created_dt TIMESTAMP, updated_dt TIMESTAMP, created_by VARCHAR(255), updated_by VARCHAR(255)` (helper `metaColumns()` + `dictPk()`).
- snake_case physical map of the dict (`AddressID`→`address_id`, table `ADDRESS_MASTER`→`address_master`).
- In-cluster reference = real FK; cross-cluster (other schema) reference = id-only soft ref (no cross-schema FK).
- Locked: `IssuedQty` = **BOOLEAN**; formula sensitive values **encrypted at rest** (FORMULA_VAULT.EncryptionKeyRef = key ref); Phase-1B items excluded.

---

## schema `iam`  (✅ BUILT — @ra/data-org)
- **org_group_master** — org_group_code v50, org_group_name v200 · + meta
- **org_type_master** — org_type_code v50, org_type_name v200 · + meta
- **org_master** — org_group_id FK→org_group_master, org_type_id FK→org_type_master, organization_code v50, organization_name v200, registration_country_id soft→platform.country_master, base_currency_id soft→platform.currency_master, default_timezone_id soft→platform.timezone_master, default_language_id soft→platform.language_master · + meta
- **org_relationship** — organization_id FK→org_master, related_organization_id FK→org_master, relationship_type v30 · + meta
- **business_unit_master** — organization_id FK→org_master, parent_business_unit_id self, business_unit_code v50, business_unit_name v200 · + meta
- **user_master** — organization_id FK→org_master, employee_code v50, user_name v200, email v150, mobile_number v20, password_hash v255, is_active BOOLEAN · + meta
- **role_master** — role_code v50, role_name v200, description TEXT · + meta
- **permission_master** — permission_code v50, permission_name v200, module_name v200 · + meta
- **role_permission_mapping** — role_id FK→role_master, permission_id FK→permission_master · + meta
- **user_role_mapping** — user_id FK→user_master, role_id FK→role_master · + meta
- **location_authority_master** — location_id soft→location.location_master, authority_user_id FK→user_master, authority_role_id FK→role_master, authority_type v50, effective_from_dt TS, effective_to_dt TS · + meta

## schema `platform`  (reference masters)
- **country_master** — country_code v50, country_name v200 · + meta
- **currency_master** — currency_code v50, currency_name v200 · + meta
- **language_master** — language_code v50, language_name v200 · + meta
- **timezone_master** — timezone_code v50, utc_offset v20 · + meta
- **address_master** — address_line1 TEXT, address_line2 TEXT, city v255, state_name v200, country_id soft→country_master, pincode v50 · + meta
- **geo_location_master** — latitude DECIMAL(10,8), longitude DECIMAL(11,8) · + meta
- **contact_master** — contact_name v200, email v150, mobile_number v20 · + meta
- **document_type_master** — document_type_code v50, document_type_name v200 · + meta
- **document_master** — document_type_id FK→document_type_master, file_name v200, file_path v255, uploaded_dt TS · + meta
- **uom_type_master** — type_code v50, type_name v200, description TEXT · + meta
- **uom_master** — uom_code v50, uom_name v200 · + meta
- **uom_conversion_master** — uom_type_id FK→uom_type_master, from_uom_id FK→uom_master, to_uom_id FK→uom_master, conversion_factor NUMERIC(18,8) NOT NULL, is_active BOOLEAN NOT NULL default true · + meta
- **brand_master** — brand_code v50, brand_name v200 · + meta

## schema `location`  (sites + warehouse hierarchy)
- **location_type_master** — type_code v50, type_name v200 · + meta
- **location_master** — organization_id soft→iam.org_master, business_unit_id soft→iam.business_unit_master, parent_location_id self, location_type_id FK→location_type_master, location_code v50, location_name v200, address_id soft→platform.address_master, geo_location_id soft→platform.geo_location_master, primary_contact_id soft→platform.contact_master · + meta
- **warehouse_type_master** — type_code v50, type_name v200 · + meta
- **warehouse_master** — location_id FK→location_master, warehouse_type_id FK→warehouse_type_master, warehouse_code v50, warehouse_name v200 · + meta
- **floor_master** — warehouse_id FK→warehouse_master, floor_code v50, floor_name v200 · + meta
- **zone_type_master** — type_code v50, type_name v200 · + meta
- **zone_master** — floor_id FK→floor_master, zone_type_id FK→zone_type_master, zone_code v50, zone_name v200 · + meta
- **rack_master** — zone_id FK→zone_master, rack_code v50, rack_name v200 · + meta
- **shelf_master** — rack_id FK→rack_master, shelf_code v50, shelf_name v200 · + meta
- **bin_master** — shelf_id FK→shelf_master, bin_code v50, bin_name v200 · + meta
- **storage_location_type_master** — type_code v50, type_name v200 · + meta
- **storage_location_status_master** — status_code v50, status_name v200, description TEXT · + meta
- **storage_location_master** — warehouse_id FK→warehouse_master, floor_id FK→floor_master, zone_id FK→zone_master, rack_id FK→rack_master, shelf_id FK→shelf_master, bin_id FK→bin_master, storage_location_code v50, storage_location_name v200 · + meta

## schema `masterdata`  (material)
- **material_type_master** — type_code v50, type_name v200 · + meta
- **material_category_master** — material_type_id FK→material_type_master, category_code v50, category_name v200 · + meta
- **material_subcategory_master** — material_category_id FK→material_category_master, sub_category_code v50, sub_category_name v200 · + meta
- **material_group** — material_subcategory_id FK→material_subcategory_master, group_code v50, group_name v200 · + meta
- **material** — material_group_id FK→material_group, material_type_id FK→material_type_master, material_category_id FK→material_category_master, material_code v50, material_name v200, uom_id soft→platform.uom_master, description TEXT · + meta
- **rm_alias** — material_id FK→material, alias_name v200, alias_type v30 · + meta   *(alias masking: ING-A001 etc.)*
- **material_qc_specifications** — material_id FK→material, qc_parameter_id soft→quality.qc_parameter_master, min_value NUMERIC(18,4), max_value NUMERIC(18,4), target_value NUMERIC(18,4) · + meta
- **material_storage_rules** — material_id FK→material, storage_location_type_id soft→location.storage_location_type_master, min_temperature v255, max_temperature v255, storage_condition v255 · + meta
- **material_ageing** — material_id FK→material, inventory_batch_id soft→inventory.inventory_batch, storage_location_id soft→location.storage_location_master, quantity_on_hand NUMERIC(18,4), uom_id soft, receipt_date DATE, snapshot_date DATE, ageing_days INT, ageing_bucket v50 · + meta

## schema `procurement`  (vendor + PR/RFQ/quotation/PO + credit)
- **vendor_details** — organization_id soft→iam.org_master, vendor_code v50, vendor_name v200, address_id soft→platform.address_master, base_currency_id soft→platform.currency_master, payment_terms v255 · + meta
- **vendor_contact** — vendor_id FK→vendor_details, contact_name v200, designation v255, email v150, mobile_number v20, is_primary BOOLEAN · + meta
- **vendor_rm_mapping** — vendor_id FK→vendor_details, material_id soft→masterdata.material, is_preferred BOOLEAN, lead_time_days INT · + meta
- **stock_requirement** — location_id soft→location, material_id soft→masterdata.material, required_qty NUMERIC(18,4), uom_id soft, required_by_date DATE, requirement_source v255, priority v255 · + meta
- **stock_req_items** — stock_requirement_id FK→stock_requirement, material_id soft, required_qty NUMERIC(18,4), uom_id soft · + meta
- **purchase_request** — pr_number v50, stock_requirement_id soft→stock_requirement, request_location_id soft→location, delivery_location_id soft→location, priority v255, expected_delivery_date DATE, approved_by soft→iam.user_master, approved_dt TS · + meta
- **purchase_request_items** — purchase_request_id FK→purchase_request, material_id soft, required_qty NUMERIC(18,4), uom_id soft · + meta
- **purchase_request_approval** — purchase_request_id FK→purchase_request, approver_user_id soft→iam.user_master, approval_level INT, approval_status v30, approved_dt TS, remarks TEXT · + meta
- **rfq_master** — rfq_number v50, purchase_request_id soft→purchase_request, rfq_date DATE, submission_deadline v255 · + meta
- **rfq_items** — rfq_id FK→rfq_master, material_id soft, required_qty NUMERIC(18,4), uom_id soft · + meta
- **rfq_vendor_mappings** — rfq_id FK→rfq_master, vendor_id FK→vendor_details, is_selected_vendor BOOLEAN · + meta
- **quotations** — rfq_id FK→rfq_master, vendor_id FK→vendor_details, quotation_number v50, quotation_date DATE, valid_until_date DATE · + meta
- **quotation_items** — quotation_id FK→quotations, material_id soft, quoted_qty NUMERIC(18,4), uom_id soft, quoted_rate NUMERIC(18,4), currency_id soft→platform.currency_master · + meta
- **purchase_order** — po_number v50, vendor_id FK→vendor_details, quotation_id soft→quotations, purchase_request_id soft→purchase_request, order_date DATE, delivery_location_id soft→location, currency_id soft, total_amount NUMERIC(18,4) · + meta
- **purchase_order_items** — purchase_order_id FK→purchase_order, material_id soft, ordered_qty NUMERIC(18,4), uom_id soft, rate NUMERIC(18,4), amount NUMERIC(18,4) · + meta
- **po_approval_order** — purchase_order_id FK→purchase_order, approver_user_id soft→iam.user_master, approval_level INT, approval_status v30, approved_dt TS, remarks TEXT · + meta
- **vendor_po_ack** — purchase_order_id soft→purchase_order, vendor_id FK→vendor_details, acknowledged_dt TS, accepted_delivery_date DATE, remarks TEXT · + meta
- **vendor_credit_reason_master** — reason_code v50, reason_description TEXT · + meta
- **vendor_credit_note** — vendor_id FK→vendor_details, grn_id soft→inventory.grn_master, vendor_credit_reason_id FK→vendor_credit_reason_master, credit_note_number v50, credit_note_date DATE, amount NUMERIC(18,4), currency_id soft · + meta
- **vendor_credit_notes_allocation** — vendor_credit_note_id FK→vendor_credit_note, purchase_order_id soft→purchase_order, allocated_amount NUMERIC(18,4) · + meta

## schema `inventory`  (gate/GRN/batch + stock)
- **gate_entry_master** — gate_entry_number v50, vendor_id soft→procurement.vendor_details, purchase_order_id soft→procurement.purchase_order, location_id soft→location, vehicle_number v20, entry_dt TS, exit_dt TS, driver_name v200 · + meta
- **gate_entry_documents** — gate_entry_id FK→gate_entry_master, document_type_id soft→platform.document_type_master, document_id soft→platform.document_master · + meta
- **grn_master** — grn_number v50, gate_entry_id soft→gate_entry_master, purchase_order_id soft→procurement.purchase_order, vendor_id soft→procurement.vendor_details, location_id soft→location, grn_date DATE · + meta
- **grn_items** — grn_id FK→grn_master, purchase_order_item_id soft→procurement.purchase_order_items, material_id soft→masterdata.material, received_qty NUMERIC(18,4), uom_id soft, accepted_qty NUMERIC(18,4), rejected_qty NUMERIC(18,4) · + meta
- **grn_container** — grn_id FK→grn_master, grn_item_id FK→grn_items, container_code v50, container_qty NUMERIC(18,4), uom_id soft · + meta
- **rm_batch_master** — grn_item_id soft→grn_items, material_id soft→masterdata.material, batch_number v50, manufacturing_date DATE, expiry_date DATE, received_qty NUMERIC(18,4), uom_id soft, storage_location_id soft→location.storage_location_master · + meta
- **batch_container_mappings** — rm_batch_id soft→rm_batch_master, grn_container_id soft→grn_container · + meta
- **batch_genealogy_history** — finished_good_batch_id soft→packaging.finished_good_batch_master, oil_batch_id soft→production.oil_batch_master, rm_batch_id soft→rm_batch_master, relationship_type v30, recorded_dt TS · + meta
- **inventory_status_master** — status_code v50, status_name v200 · + meta
- **inventory_batch** — rm_batch_id soft→rm_batch_master, material_id soft→masterdata.material, storage_location_id soft→location.storage_location_master, inventory_status_id FK→inventory_status_master, quantity_on_hand NUMERIC(18,4), uom_id soft · + meta
- **inventory_transaction_type_master** — type_code v50, type_name v200 · + meta
- **inventory_transaction** — inventory_batch_id FK→inventory_batch, inventory_transaction_type_id FK→inventory_transaction_type_master, transaction_qty NUMERIC(18,4), uom_id soft, from_location_id soft→location, to_location_id soft→location, transaction_dt TS, reference_document_id soft · + meta
- **inventory_event_history** — inventory_batch_id soft→inventory_batch, event_type v50, event_dt TS, inventory_transaction_id soft→inventory_transaction (NULL for non-qty), reference_document_id soft, reference_document_type v50 (GRN/PO/PRODUCTION_ORDER), performed_by soft→iam.user_master, remarks TEXT · + meta
- **stock_adjustment** — inventory_batch_id FK→inventory_batch, adjustment_qty NUMERIC(18,4), uom_id soft, adjustment_reason TEXT, adjustment_dt TS, approved_by soft→iam.user_master · + meta
- **stock_audit** — audit_code v50, audit_type v30 (FULL/CYCLE/SPOT), location_id soft→location, audit_start_dt TS, audit_end_dt TS, initiated_by soft→iam.user_master, approved_by soft, approved_dt TS, remarks TEXT · + meta
- **stock_audit_details** — stock_audit_id FK→stock_audit, material_id soft, inventory_batch_id soft→inventory_batch, storage_location_id soft→location, system_qty NUMERIC(18,4), counted_qty NUMERIC(18,4), variance_qty NUMERIC(18,4), uom_id soft, counted_by soft→iam.user_master, counted_dt TS, variance_reason TEXT · + meta
- **stock_reservation** — inventory_batch_id FK→inventory_batch, reserved_qty NUMERIC(18,4), uom_id soft, reserved_for_document_id soft, reserved_dt TS, released_dt TS · + meta
- **stock_transfer** — inventory_batch_id FK→inventory_batch, from_location_id soft→location, to_location_id soft→location, transfer_qty NUMERIC(18,4), uom_id soft, transfer_dt TS, requested_by soft→iam.user_master · + meta
- **expiry_tracker** — batch_type v30 NOT NULL (RM/OIL/FG), rm_batch_id soft→rm_batch_master, oil_batch_id soft→production.oil_batch_master, finished_good_batch_id soft→packaging.finished_good_batch_master, material_id soft, manufacturing_date DATE, expiry_date DATE, remaining_days INT, alert_threshold_days INT, alert_sent_dt TS, alert_sent_to soft→iam.user_master · + meta

## schema `quality`  (QC)
- **qc_parameter_master** — parameter_code v50, parameter_name v200, uom_id soft→platform.uom_master · + meta
- **qc_inspections** — rm_batch_id soft→inventory.rm_batch_master, inspection_role_id soft→iam.role_master, inspector_user_id soft→iam.user_master, inspection_dt TS, overall_result v255 · + meta
- **qc_result_details** — qc_inspection_id FK→qc_inspections, qc_parameter_id soft→qc_parameter_master, observed_value NUMERIC(18,4), result v255 · + meta
- **qc_attachments** — qc_inspection_id FK→qc_inspections, document_id soft→platform.document_master · + meta
- **qc_sample_retention** — qc_inspection_id soft→qc_inspections, rm_batch_id soft→inventory.rm_batch_master, oil_batch_id soft→production.oil_batch_master, sample_code v50, sample_qty NUMERIC(18,4), uom_id soft, retention_location_id soft→location, retained_dt TS, retained_by soft→iam.user_master, retention_expiry_dt TS · + meta
- **qc_disposition** — qc_inspection_id FK→qc_inspections, disposition_code v50 (ACCEPT/REJECT/REWORK/CONDITIONAL), disposition_reason TEXT, conditions TEXT, disposed_by soft→iam.user_master, disposed_dt TS · + meta   *(table only; CAPA workflow = Phase-1B)*
- **qc_capa** — qc_inspection_id soft→qc_inspections, capa_code v50, capa_type v30 (CORRECTIVE/PREVENTIVE), description TEXT, root_cause TEXT, action_plan TEXT, assigned_to soft→iam.user_master, due_dt TS, closed_dt TS, closure_evidence TEXT, verified_by soft, verified_dt TS · + meta   *(table only; CAPA workflow = Phase-1B)*

## schema `formula`  (ENCRYPTED, own role)
- **formula_type_master** — type_code v50, type_name v200 · + meta
- **formula_master** — formula_type_id FK→formula_type_master, formula_code v50, formula_name v200, formula_owner_user_id soft→iam.user_master, current_version_id soft→formula_version · + meta
- **formula_version** — formula_id FK→formula_master, version_number INT, approved_by soft→iam.user_master, approved_dt TS · + meta
- **formula_ingredients** — formula_version_id FK→formula_version, material_id soft→masterdata.material **[ENCRYPTED at rest]**, percentage NUMERIC(18,4) **[ENCRYPTED]**, sequence_no INT · + meta
- **formula_stage_master** — formula_version_id FK→formula_version, stage_name v200, sequence_no INT, stage_instructions v255 · + meta
- **formula_stage_ingredients** — formula_stage_id FK→formula_stage_master, material_id soft **[ENCRYPTED]**, percentage NUMERIC(18,4) **[ENCRYPTED]**, sequence_no INT · + meta
- **formula_vault** — formula_id FK→formula_master, encryption_key_ref v255, vault_location v255 · + meta
- **formula_access_policy** — formula_id FK→formula_master, role_id soft→iam.role_master, user_id soft→iam.user_master, access_level INT · + meta
- **formula_approval** — formula_version_id FK→formula_version, approver_user_id soft→iam.user_master, approval_level INT, approval_status v30, approved_dt TS, remarks TEXT · + meta
- **formula_change_log** — formula_id FK→formula_master, formula_version_id soft→formula_version, field_name v200, old_value TEXT, new_value TEXT, change_reason TEXT, changed_by soft→iam.user_master, changed_dt TS · + meta
- **formula_copy_request** — source_formula_id soft→formula_master, source_version_id soft→formula_version, target_formula_id soft→formula_master, requested_by soft→iam.user_master, requested_dt TS, approved_by soft, approved_dt TS, copy_notes TEXT · status=PENDING/APPROVED/REJECTED/COMPLETED · + meta
- **formula_document_mapping** — formula_id FK→formula_master, formula_version_id soft→formula_version, document_type_id soft→platform.document_type_master, document_id soft→platform.document_master · + meta
- **formula_event_hist** — formula_id FK→formula_master, formula_version_id soft→formula_version, event_type v50, event_dt TS, performed_by soft→iam.user_master, remarks TEXT · + meta

## schema `production`
- **production_plan** — location_id soft→location, plan_date DATE, planned_start_dt TS, planned_end_dt TS · + meta
- **production_plan_items** — production_plan_id FK→production_plan, formula_id soft→formula.formula_master, planned_qty NUMERIC(18,4), uom_id soft · + meta
- **production_order** — production_plan_item_id soft→production_plan_items, formula_version_id soft→formula.formula_version, location_id soft→location, order_qty NUMERIC(18,4), uom_id soft, actual_start_dt TS, actual_end_dt TS · + meta
- **production_order_ingredients** — production_order_id FK→production_order, material_id soft, required_qty NUMERIC(18,4), issued_qty **BOOLEAN**, uom_id soft · + meta
- **material_pick_list** — production_order_id soft→production_order, pick_list_date DATE, generated_by soft→iam.user_master · + meta
- **material_pick_list_items** — material_pick_list_id FK→material_pick_list, material_id soft, inventory_batch_id soft→inventory.inventory_batch, picked_qty NUMERIC(18,4), uom_id soft · + meta
- **material_issue** — production_order_id soft→production_order, material_pick_list_id soft→material_pick_list, issued_dt TS, issued_by soft→iam.user_master · + meta
- **material_issue_item** — material_issue_id FK→material_issue, material_id soft, inventory_batch_id soft→inventory.inventory_batch, issued_qty **BOOLEAN**, uom_id soft · + meta
- **secure_mixing_session** — production_order_id soft→production_order, operator_id soft→iam.user_master, session_start_dt TS, session_end_dt TS · + meta
- **mixing_step_log** — secure_mixing_session_id FK→secure_mixing_session, formula_stage_id soft→formula.formula_stage_master, step_sequence INT, step_description TEXT, performed_dt TS, performed_by soft→iam.user_master · + meta
- **oil_batch_master** — production_order_id soft→production_order, secure_mixing_session_id soft→secure_mixing_session, batch_number v50, produced_qty NUMERIC(18,4), uom_id soft, produced_dt TS · + meta
- **oil_batch_consumption** — oil_batch_id FK→oil_batch_master, consumed_for_document_id soft, consumed_qty NUMERIC(18,4), uom_id soft, consumed_dt TS · + meta
- **oil_batch_event_history** — oil_batch_id FK→oil_batch_master, event_type v30, event_dt TS, performed_by soft→iam.user_master, remarks TEXT · + meta
- **production_qc** — oil_batch_id soft→oil_batch_master, qc_parameter_id soft→quality.qc_parameter_master, observed_value NUMERIC(18,4), result v255, inspected_by soft→iam.user_master, inspection_dt TS · + meta
- **oil_batch_qc_history** — oil_batch_id FK→oil_batch_master, production_qc_id soft→production_qc, recorded_dt TS · + meta

## schema `packaging`
- **product_category_master** — category_code v50, category_name v200 · + meta
- **product_master** — formula_id soft→formula.formula_master, brand_id soft→platform.brand_master, product_category_id FK→product_category_master, product_code v50, product_name v200 · + meta
- **product_sku** — product_id FK→product_master, sku_code v50, pack_size v255, uom_id soft · + meta
- **packaging_material_master** — packaging_material_code v50, packaging_material_name v200, uom_id soft · + meta
- **packaging_bom_master** — product_sku_id soft→product_sku, packaging_material_id soft→packaging_material_master, required_qty NUMERIC(18,4), uom_id soft · + meta
- **package_order** — product_sku_id soft→product_sku, oil_batch_id soft→production.oil_batch_master, location_id soft→location, order_qty NUMERIC(18,4), uom_id soft, planned_start_dt TS, planned_end_dt TS · + meta
- **package_order_item** — package_order_id FK→package_order, packaging_material_id soft→packaging_material_master, required_qty NUMERIC(18,4), issued_qty **BOOLEAN**, uom_id soft · + meta
- **filling_session** — package_order_id soft→package_order, operator_id soft→iam.user_master, session_start_dt TS, session_end_dt TS · + meta
- **filling_session_details** — filling_session_id FK→filling_session, filled_qty NUMERIC(18,4), uom_id soft, rejected_qty NUMERIC(18,4), recorded_dt TS · + meta
- **finished_good_batch_master** — package_order_id soft→package_order, product_sku_id soft→product_sku, batch_number v50, produced_qty NUMERIC(18,4), uom_id soft, manufacturing_date DATE, expiry_date DATE · + meta
- **finished_goods_batch_consumption** — finished_good_batch_id FK→finished_good_batch_master, consumed_for_document_id soft, consumed_qty NUMERIC(18,4), uom_id soft, consumed_dt TS · + meta

## schema `sales`
- **customer_master** — customer_code v50, customer_name v200, address_id soft→platform.address_master, base_currency_id soft→platform.currency_master · + meta
- **transporter_master** — transporter_code v50, transporter_name v200, contact_id soft→platform.contact_master, address_id soft→platform.address_master · + meta
- **sales_order** — so_number v50, customer_id soft→customer_master, order_date DATE, delivery_location_id soft→location, currency_id soft→platform.currency_master, total_amount NUMERIC(18,4) · + meta
- **sales_order_items** — sales_order_id FK→sales_order, product_sku_id soft→packaging.product_sku, ordered_qty NUMERIC(18,4), uom_id soft, rate NUMERIC(18,4), amount NUMERIC(18,4) · + meta
- **dispatch_master** — sales_order_id soft→sales_order, customer_id soft→customer_master, dispatch_date DATE, vehicle_number v20, transporter_id soft→transporter_master · + meta
- **dispatch_items** — dispatch_id FK→dispatch_master, sales_order_item_id soft→sales_order_items, finished_good_batch_id soft→packaging.finished_good_batch_master, dispatched_qty NUMERIC(18,4), uom_id soft · + meta

## schema `workflow`  (lightweight state engine — NOT a dynamic builder)
- **workflow_state_master** — workflow_name v200 (e.g. FORMULA_APPROVAL), state_code v50 (DRAFT/SUBMITTED/APPROVED), state_name v200, is_initial BOOLEAN NOT NULL default false, is_final BOOLEAN NOT NULL default false, sort_order INT · + meta
- **workflow_transaction_master** — workflow_name v200, entity_type v100 (PURCHASE_REQUEST/FORMULA/PO), entity_id UUID, from_state_id soft→workflow_state_master, to_state_id soft→workflow_state_master, transition_action v100 (SUBMIT/APPROVE/REJECT/RECALL), performed_by soft→iam.user_master, transaction_dt TS, comments TEXT · + meta

---
*v = VARCHAR, TS = TIMESTAMP, INT = INTEGER, soft = id-only soft ref (no cross-schema FK), FK = in-schema FK.*
