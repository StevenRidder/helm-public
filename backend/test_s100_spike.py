#!/usr/bin/env python3
"""Tests for the LABS-5 S-100 ingestion spike."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from labs.s100_spike import (
    INVENTORY_SCHEMA,
    PRODUCT_MAPPINGS,
    build_fixture_inventory,
    build_fixture_probe_registry,
    layer_by_product,
    sample_surface_current_path,
)


class S100SpikeTest(unittest.TestCase):
    def test_inventory_contains_required_s100_products_and_metadata(self):
        inventory = build_fixture_inventory()
        self.assertEqual(inventory["schema"], INVENTORY_SCHEMA)
        products = {layer["product_identifier"] for layer in inventory["layers"]}
        self.assertEqual(products, {"S-102", "S-104", "S-111", "S-124", "S-129"})

        for layer in inventory["layers"]:
            self.assertEqual(layer["producer_code"], "HELM-LABS")
            self.assertTrue(layer["not_for_navigation"])
            self.assertIn("dataset_edition", layer)
            self.assertIn("dataset_reference_date", layer)
            self.assertIn("source_links", layer)
            self.assertEqual(layer["coverage"]["status"], "area")
            self.assertEqual(layer["coverage"]["region"], "Fiji reef-pass fixture")

    def test_product_mappings_keep_semantics_out_of_the_backend_renderer(self):
        inventory = build_fixture_inventory()
        expected_contracts = {
            "S-102": "depth.bathymetry",
            "S-104": "tides.water_level",
            "S-111": "tides.current",
            "S-124": "warnings.navigation",
            "S-129": "pass.ukc",
        }
        for product_id, contract in expected_contracts.items():
            layer = layer_by_product(inventory, product_id)
            self.assertEqual(layer["target_contract"]["name"], contract)
            self.assertEqual(layer["probe_handle"], PRODUCT_MAPPINGS[product_id]["probe_handle"])

        self.assertIn("ukc_input", layer_by_product(inventory, "S-102")["target_contract"]["uses"])
        self.assertIn("safety_contour_adjustment", layer_by_product(inventory, "S-104")["target_contract"]["uses"])
        self.assertIn("route_warnings", layer_by_product(inventory, "S-124")["target_contract"]["uses"])
        self.assertIn("pass_conditions", layer_by_product(inventory, "S-129")["target_contract"]["uses"])

    def test_fixture_registry_exposes_s100_layers_through_probe_contract(self):
        inventory = build_fixture_inventory()
        registry = build_fixture_probe_registry(inventory)
        self.assertEqual(
            registry.layer_ids(),
            [
                "s102.bathymetry",
                "s104.water_level",
                "s111.surface_current",
                "s124.navigation_warning",
                "s129.under_keel_clearance",
            ],
        )

        current = registry.sample("s111.surface_current", -17.75, 178.12, "2026-06-29T06:00:00Z")
        self.assertEqual(current["status"], "ok")
        self.assertEqual(current["unit"], "kn")
        self.assertEqual(current["value"]["current"]["speedKn"], 1.2)
        self.assertEqual(current["sourceRef"]["productId"], "S-111")
        self.assertEqual(current["sourceRef"]["targetContract"], "tides.current")
        self.assertEqual(current["coverage"]["status"], "area")
        self.assertTrue(current["notForNavigation"])

    def test_out_of_coverage_stays_honest(self):
        registry = build_fixture_probe_registry(build_fixture_inventory())
        sample = registry.sample("s102.bathymetry", 0.0, 0.0, "2026-06-29T06:00:00Z")
        self.assertEqual(sample["status"], "out_of_coverage")
        self.assertNotIn("value", sample)
        self.assertEqual(sample["coverage"]["status"], "out_of_coverage")
        self.assertEqual(sample["sourceRef"]["productId"], "S-102")

    def test_documented_sample_path_goes_from_s111_inventory_to_layersample(self):
        sample = sample_surface_current_path()
        self.assertEqual(sample["layer"], "s111.surface_current")
        self.assertEqual(sample["status"], "ok")
        self.assertEqual(sample["source"], "s100-fixture")
        self.assertEqual(sample["freshness"], "fixture-valid-2026-06-29")
        self.assertIn("backend.labs.s100_spike", sample["sourceRef"]["trace"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
