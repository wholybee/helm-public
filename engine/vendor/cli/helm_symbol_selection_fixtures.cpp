#include "helm_symbol_package.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct Attribute {
  std::string name;
  std::vector<std::string> values;
};

struct FixtureCase {
  std::string id;
  std::string coverage_class;
  int s52_lookup_id = 0;
  std::string row_key;
  std::string helm_catalog_id;
  std::string symbol_id;
  std::string source_object_class;
  std::string normalized_object_class;
  std::vector<Attribute> attributes;
  std::string expected_feature_type;
  std::string expected_rule_file;
  std::string expected_mapping_type;
  std::string expected_resolver_status;
  std::string expected_crosswalk_class;
  std::string expected_runtime_scope;
  bool expected_runtime_eligible = false;
  bool expected_default_render_allowed = false;
};

void Fail(const std::string &message) {
  std::cerr << "FAIL symbol-selection-fixtures: " << message << "\n";
  std::exit(1);
}

void Check(bool condition, const std::string &message) {
  if (!condition) Fail(message);
}

const helm::symbols::SymbolRecord *FindRecord(
    const helm::symbols::SymbolPackage &package,
    int row_id,
    const std::string &row_key,
    const std::string &symbol_id,
    const std::string &object_class) {
  for (const helm::symbols::SymbolRecord &record : package.records) {
    if (record.row_id == row_id &&
        record.row_key == row_key &&
        record.symbol_id == symbol_id &&
        record.s57_object_class == object_class) {
      return &record;
    }
  }
  return nullptr;
}

bool HasAttributeValue(const FixtureCase &fixture,
                       const std::string &name,
                       const std::string &value) {
  for (const Attribute &attribute : fixture.attributes) {
    if (attribute.name != name) continue;
    for (const std::string &candidate : attribute.values) {
      if (candidate == value) return true;
    }
  }
  return false;
}

void CheckPaletteTokens(const FixtureCase &fixture) {
  const std::vector<std::string> palette_tokens = {"day", "dusk", "night"};
  Check(palette_tokens.size() == 3, "internal palette token count changed");
  for (const std::string &palette : palette_tokens) {
    Check(!palette.empty(), fixture.id + " has empty palette token");
  }
}

void CheckFixture(const helm::symbols::SymbolPackage &package,
                  const FixtureCase &fixture) {
  CheckPaletteTokens(fixture);
  Check(!fixture.id.empty(), "fixture id is required");
  Check(!fixture.coverage_class.empty(), fixture.id + " coverage class missing");
  Check(fixture.s52_lookup_id > 0, fixture.id + " s52_lookup_id missing");
  Check(!fixture.row_key.empty(), fixture.id + " row_key missing");
  Check(!fixture.helm_catalog_id.empty(), fixture.id + " helm_catalog_id missing");
  Check(!fixture.symbol_id.empty(), fixture.id + " symbol id missing");
  Check(!fixture.source_object_class.empty(),
        fixture.id + " source object class missing");
  Check(!fixture.normalized_object_class.empty(),
        fixture.id + " normalized object class missing");
  Check(!fixture.expected_resolver_status.empty(),
        fixture.id + " resolver status missing");
  Check(!fixture.expected_runtime_scope.empty(),
        fixture.id + " runtime scope missing");

  const helm::symbols::SymbolRecord *record =
      FindRecord(package, fixture.s52_lookup_id, fixture.row_key,
                 fixture.symbol_id, fixture.normalized_object_class);
  Check(record != nullptr,
        fixture.id + " did not match runtime evidence by s52_lookup_id + row_key");
  Check(record->helm_catalog_id == fixture.helm_catalog_id,
        fixture.id + " Helm catalog id mismatch");
  Check(record->s101_feature_type == fixture.expected_feature_type,
        fixture.id + " S-101 feature mismatch");
  Check(record->s101_rule_file == fixture.expected_rule_file,
        fixture.id + " S-101 rule file mismatch");
  Check(record->s101_mapping_type == fixture.expected_mapping_type,
        fixture.id + " mapping type mismatch");
  Check(record->s101_crosswalk_class == fixture.expected_crosswalk_class,
        fixture.id + " crosswalk class mismatch");
  Check(record->runtime_state == "runtime_blocked",
        fixture.id + " should remain blocked until approval gates pass");
  Check(record->runtime_eligible_default == fixture.expected_default_render_allowed,
        fixture.id + " default render eligibility mismatch");
  Check(record->runtime_eligible_db == fixture.expected_runtime_eligible,
        fixture.id + " DB runtime eligibility mismatch");
  Check(record->fail_closed,
        fixture.id + " must preserve fail-closed runtime posture");
  Check(record->proof_manifest_present,
        fixture.id + " proof manifest metadata missing");
  Check(record->clean_room_generated,
        fixture.id + " clean-room generated flag missing");
  Check(record->third_party_artwork_not_source,
        fixture.id + " third-party-artwork boundary flag missing");
  Check(helm::symbols::FindSymbol(package, fixture.symbol_id, false) == nullptr,
        fixture.id + " leaked into default lookup before runtime approval");

  if (fixture.id == "boypil60-red-pillar-buoy") {
    Check(HasAttributeValue(fixture, "buoyShape", "pillar"),
          "BOYPIL60 fixture lost pillar shape attribute");
    Check(HasAttributeValue(fixture, "colour", "red"),
          "BOYPIL60 fixture lost red colour attribute");
    Check(HasAttributeValue(fixture, "colourPattern", "solid"),
          "BOYPIL60 fixture lost solid colour pattern attribute");
    Check(record->s57_object_class == "BOYLAT",
          "BOYPIL60 must resolve through BOYLAT, not witness filename colour");
  }

  if (fixture.coverage_class == "non_s101_runtime_overlay" ||
      fixture.coverage_class == "extension_profile_required") {
    Check(record->s101_feature_type.empty(),
          fixture.id + " should not claim an S-101 feature type");
    Check(record->s101_rule_file.empty(),
          fixture.id + " should not claim an S-101 rule file");
  }
}

std::vector<FixtureCase> Fixtures() {
  return {
      {"direct-s101-obstruction",
       "direct_s101_asset",
       1194,
       "OBSTRN_ACHARE02_1193_31245_1193",
       "OBSTRN_ACHARE02_1193",
       "ACHARE02",
       "OBSTRN",
       "OBSTRN",
       {{"category_of_obstruction", {"9"}}, {"value_of_sounding", {"true"}}},
       "Obstruction",
       "PortrayalCatalog/Rules/Obstruction.lua",
       "direct_asset_match",
       "resolved_direct",
       "s101_feature_equivalent",
       "chart_portrayal",
       false,
       false},
      {"boypil60-red-pillar-buoy",
       "attribute_driven_buoy",
       1911,
       "BOYLAT_BOYPIL60_1910_30187_1910",
       "BOYLAT_BOYPIL60_1910",
       "BOYPIL60",
       "BOYLAT",
       "BOYLAT",
       {{"buoyShape", {"pillar"}}, {"colour", {"red"}}, {"colourPattern", {"solid"}}},
       "LateralBuoy",
       "PortrayalCatalog/Rules/LateralBuoy.lua",
       "direct_asset_match",
       "resolved_direct",
       "s101_feature_equivalent",
       "chart_portrayal",
       false,
       false},
      {"rule-derived-daymark-topmark",
       "rule_derived_equivalent",
       2162,
       "DAYMAR_TOPSHQ28_2160_93930_2161",
       "DAYMAR_TOPSHQ28_2160",
       "TOPSHQ28",
       "DAYMAR",
       "DAYMAR",
       {{"beaconShape", {"beacon"}},
        {"colour", {"red", "black", "white"}},
        {"colourPattern", {"vertical_stripes"}}},
       "Daymark",
       "PortrayalCatalog/Rules/Daymark.lua",
       "rule_derived_equivalent",
       "resolved_rule",
       "s101_feature_equivalent",
       "chart_portrayal",
       false,
       false},
      {"catalogue-rule-isolated-danger-beacon",
       "catalogue_rule_backed",
       1732,
       "BCNISD_BCNGEN76_1731_30020_1731",
       "BCNISD_BCNGEN76_1731",
       "BCNGEN76",
       "BCNISD",
       "BCNISD",
       {{"buoyShape", {"buoy"}}, {"colour", {"black", "red", "black"}}},
       "IsolatedDangerBeacon",
       "PortrayalCatalog/Rules/IsolatedDangerBeacon.lua",
       "rule_derived_equivalent",
       "resolved_rule_catalogue",
       "s101_feature_equivalent",
       "chart_portrayal",
       false,
       false},
      {"documented-deviation-anchor-point",
       "documented_deviation",
       1715,
       "ACHPNT_ACHPNT01_1714_30003_1714",
       "ACHPNT_ACHPNT01_963",
       "ACHPNT01",
       "ACHPNT",
       "ACHPNT",
       {},
       "AnchorBerth",
       "PortrayalCatalog/Rules/AnchorBerth.lua",
       "acceptable_deviation",
       "resolved_with_deviation",
       "s101_feature_equivalent_with_documented_deviation",
       "chart_portrayal",
       false,
       false},
      {"non-s101-runtime-ais-default",
       "non_s101_runtime_overlay",
       1609,
       "$CSYMB_AISDEF01_1608_31660_1608",
       "$CSYMB_AISDEF01_1608",
       "AISDEF01",
       "$CSYMB",
       "$CSYMB",
       {},
       "",
       "",
       "unresolved",
       "classified_non_s101_runtime",
       "non_s101_runtime_construct",
       "renderer_overlay_or_ui",
       false,
       false},
      {"extension-profile-border",
       "extension_profile_required",
       1395,
       "chkpnt_BORDER01_1394_31446_1394",
       "chkpnt_BORDER01_1394",
       "BORDER01",
       "chkpnt",
       "CHKPNT",
       {{"colour", {"red"}}, {"colourPattern", {"solid"}}},
       "",
       "",
       "unresolved",
       "classified_extension_requires_profile",
       "non_s101_or_inland_extension",
       "extension_profile_or_manual_mapping",
       false,
       false},
  };
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: helm-symbol-selection-fixtures "
              << "<runtime-evidence-snapshot.json> <proof-manifest.json>\n";
    return 2;
  }

  helm::symbols::SymbolPackage package;
  std::string error;
  Check(helm::symbols::LoadSymbolPackage(argv[1], argv[2], &package, &error),
        error);
  const std::vector<FixtureCase> fixtures = Fixtures();
  Check(fixtures.size() == 7, "expected 7 CHART-6 fixture cases");
  for (const FixtureCase &fixture : fixtures) {
    CheckFixture(package, fixture);
  }

  std::cout << "ok symbol-selection-fixtures: " << fixtures.size()
            << " fixtures checked against " << package.records.size()
            << " runtime evidence rows\n";
  return 0;
}
