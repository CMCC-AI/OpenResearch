import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('cleanup_project', Path(__file__).with_name('cleanup-project.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CleanupTests(unittest.TestCase):
    def test_only_old_completed_archives_are_removed_and_changed_files_block(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / '.mobilesci-updates'
            root.mkdir()
            now = time.time()
            for index in range(4):
                directory = root / f'{index:016x}'
                directory.mkdir()
                for name, data in [('exit-code', '0'), ('bundle.tgz', 'archive'), ('deploy.log', 'retain evidence'), ('manifest.json', '{}')]:
                    file = directory / name
                    file.write_text(data)
                    stamp = now - (10 + index) * 86400
                    os.utime(file, (stamp, stamp))
            preview = module.plan(root)
            self.assertEqual(len(preview['entries']), 2)
            target = root / preview['entries'][0]['path']
            target.write_text('changed')
            with self.assertRaisesRegex(ValueError, 'changed'):
                module.apply(root, preview)
            preview = module.plan(root)
            result = module.apply(root, preview)
            self.assertEqual(len(result['removed']), 1)
            self.assertTrue((root / '0000000000000000/bundle.tgz').exists())
            self.assertTrue((root / '0000000000000003/deploy.log').exists())
            self.assertTrue((root / '0000000000000003/manifest.json').exists())

    @unittest.skipUnless(os.name == 'posix', 'server uses POSIX symlinks')
    def test_symlinks_cannot_expand_cleanup_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            outside = base / 'another-project'
            outside.mkdir()
            (outside / 'bundle.tgz').write_text('keep')
            root = base / '.mobilesci-updates'
            root.mkdir()
            (root / '0000000000000000').symlink_to(outside, target_is_directory=True)
            self.assertEqual(module.plan(root)['entries'], [])
            with self.assertRaises(ValueError):
                module.apply(root, {'format': 1, 'root': str(root), 'entries': [{'path': '../another-project/bundle.tgz'}]})
            self.assertEqual((outside / 'bundle.tgz').read_text(), 'keep')
