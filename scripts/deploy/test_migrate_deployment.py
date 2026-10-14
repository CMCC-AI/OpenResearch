import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('migration',Path(__file__).with_name('migrate-deployment.py'))
migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)

class BrandMigrationTests(unittest.TestCase):
    def test_rename_updates_paths_project_names_and_environment_flags(self):
        old='legacy';new='mobilesci'
        self.assertEqual(migration.rename_text('/opt/legacy/state legacy-remote_research_home LEGACY_PREPARE_CORE',old,new),'/opt/mobilesci/state mobilesci-remote_research_home MOBILESCI_PREPARE_CORE')
    def test_rename_does_not_touch_unrelated_words(self):
        self.assertEqual(migration.rename_text('personal legacyword xlegacy','legacy','mobilesci'),'personal legacyword xlegacy')
    def test_product_marker_uses_display_name(self):
        self.assertEqual(migration.rename_text('# LEGACY shared gateway','legacy','mobilesci'),'# MobileSci shared gateway')

if __name__=='__main__':unittest.main()
