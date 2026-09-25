# Hikvision pilot: selected target and open integration requirements

Vendor #1 is Hikvision. HikCentral is not a V1 dependency.

| Component      | Selected target                                       | Still to establish                                                                                                                               |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| UHF reader     | DS-TRI900-1/A                                         | Exact regional SKU, radio approval, firmware, EPC-to-Wiegand mapping, and accessible Ethernet event protocol                                     |
| UHF controller | DS-TME200-D/P or reviewed local equivalent            | Exact model/firmware, SDK or local protocol, event transport, command transport, and standalone authorization behavior                           |
| Barrier        | DS-TMG320 series                                      | Exact suffix, boom length/orientation, approved control wiring and pulse duration, feedback signals, manual release and power-loss configuration |
| Radar          | DS-TMG035 series                                      | Exact presence/safety outputs and manufacturer-approved connection to the barrier                                                                |
| Tags           | Compatible EPC C1 Gen2 / ISO 18000-6C windshield tags | Vendor-qualified tag, mapping, installation placement, transfer resistance, and actual vehicles                                                  |

These are integration targets, not an order or confirmed bill of materials. No hardware was purchased, connected, or actuated.

## Verified source and its limits

The reviewed **DS-TMG320-H/B** datasheet lists open/close/stop groups, raised/lowered limit signals, RS-485, and an IR/vehicle-detector/radar interface. It identifies separate left/right variants. Automatic raising on loss of power is an optional separately ordered module for that listed model. These details cannot be assumed for every DS-TMG320 suffix. [Hikvision DS-TMG320-H/B datasheet](https://assets.hikvision.com/prd/normal/all/doc/m000172609/DS-TMG320-H-B_Datasheet_20250814.pdf)

The supplied reader PDF did not expose readable content through the research tool, and the TPP download page timed out. The numerical reader specifications in the supplied proposal have therefore not been independently confirmed here. General Hikvision ISAPI support does not establish that a particular DS-TME200 firmware exposes a usable reader stream and barrier command endpoint.

Reference links supplied for follow-up:

- [Hikvision UHF access topology](https://pro-av.hikvision.com/my/Solutions/solutions-for-small-medium-business/Quick-Pass-for-People-and-Vehicle-Access-Control/)
- [DS-TRI900-1/A regional datasheet](https://www.hikvision.com/content/dam/hikvision/en/support/regional-materials/colombia/DS-TRI900-1_A_Datasheet_20250903.pdf)
- [Hikvision TPP integration material](https://tpp.hikvision.com/download/)

## Resolve control ownership before wiring

The intended authority is SmartGate's local edge policy. Confirm that the controller can deliver read events and accept an authorized open command without also opening independently from an unsynchronized internal allowlist.

A supported approach could use a verified controller protocol. Another could use a documented Wiegand capture interface and isolated I/O hardware. The I/O hardware and its electrical interface have not been selected. No generic GPIO, relay voltage, RS-485 frame, ISAPI path, or controller event payload has been invented.

Confirm whether the reader sends a complete EPC or a mapped card number. The implementation stores `epc`, `wiegand26`, and `wiegand34` as different formats. A conventional Wiegand 26/34 frame contains parity plus a shortened payload; it is not interchangeable with a full EPC. Check the actual device's mapping and parity configuration using vendor documentation and captured test data.

## Evidence needed to finish the driver

1. Exact reader/controller SKUs and firmware, plus the relevant protocol/SDK documentation.
2. A sanitized sample of real reader events and the documented command/acknowledgement sequence.
3. Approved I/O module, wiring diagram, electrical limits, isolation, pulse behavior, and feedback mapping.
4. A bench or supervised test lane on which the installer can validate the integration.
5. Demonstrated controller behavior during edge disconnection, reboot, and conflicting authorization sources.

Credential setup should be completed by the operator through a secure local process; no production passwords or private keys are embedded in this repository.

## Physical acceptance before a resident pilot

Validate lane-specific reading, nearby-tag rejection, tinted glass and actual vehicle types, barriers that are obstructed or stalled, detector faults, emergency/manual access, power loss, and restoration. Keep the anti-fall protection directly enforced by the barrier system. Measure passage separately from authorization or the arm being raised.

A real hardware result requires observed device behavior and installer sign-off. Simulator tests and the current adapter interfaces do not satisfy that gate.
