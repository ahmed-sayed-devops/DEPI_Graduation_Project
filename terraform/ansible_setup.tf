# 1. Auto-generate Ansible Inventory with live Private IPs
resource "local_file" "ansible_inventory" {
  filename = "${path.module}/inventory.ini"
  content  = <<-EOF
[k8s_master]
k8s-master-1 ansible_host=${aws_instance.k8s_master.private_ip}

[k8s_workers]
k8s-worker-1 ansible_host=${aws_instance.k8s_workers[0].private_ip}
k8s-worker-2 ansible_host=${aws_instance.k8s_workers[1].private_ip}

[k8s_cluster:children]
k8s_master
k8s_workers

[k8s_cluster:vars]
ansible_user=ubuntu
ansible_ssh_private_key_file=/home/ubuntu/.ssh/${var.project_name}-key.pem
ansible_ssh_common_args='-o StrictHostKeyChecking=no'
EOF
}

# 2. Push Key, Inventory & Playbooks to Bastion and Trigger Ansible Automatically
resource "null_resource" "bastion_ansible_bootstrap" {
  depends_on = [
    aws_instance.bastion,
    aws_eip.bastion_eip,
    aws_instance.k8s_master,
    aws_instance.k8s_workers,
    local_file.private_key,
    local_file.ansible_inventory
  ]

  triggers = {
    bastion_id        = aws_instance.bastion.id
    inventory_content = local_file.ansible_inventory.content
    playbook_hash     = filesha256("${path.module}/../ansible/site.yml")
    ansible_cfg_hash  = filesha256("${path.module}/../ansible/ansible.cfg")
  }

  connection {
    type        = "ssh"
    host        = aws_eip.bastion_eip.public_ip
    user        = "ubuntu"
    private_key = tls_private_key.rsa_key.private_key_pem
    timeout     = "5m"
  }

  provisioner "file" {
    source      = "${path.module}/${var.project_name}-key.pem"
    destination = "/home/ubuntu/${var.project_name}-key.pem"
  }

  provisioner "file" {
    source      = "${path.module}/inventory.ini"
    destination = "/home/ubuntu/inventory.ini"
  }

  provisioner "file" {
    source      = "${path.module}/../ansible/ansible.cfg"
    destination = "/home/ubuntu/ansible.cfg"
  }

  provisioner "file" {
    source      = "${path.module}/../ansible/site.yml"
    destination = "/home/ubuntu/site.yml"
  }

  provisioner "remote-exec" {
    inline = [
      "mkdir -p /home/ubuntu/.ssh /home/ubuntu/ansible",
      "mv -f /home/ubuntu/${var.project_name}-key.pem /home/ubuntu/.ssh/${var.project_name}-key.pem",
      "chmod 400 /home/ubuntu/.ssh/${var.project_name}-key.pem",
      "mv -f /home/ubuntu/inventory.ini /home/ubuntu/ansible/inventory.ini",
      "mv -f /home/ubuntu/ansible.cfg /home/ubuntu/ansible/ansible.cfg",
      "mv -f /home/ubuntu/site.yml /home/ubuntu/ansible/site.yml",
      "cloud-init status --wait || true",
      "cd /home/ubuntu/ansible && ansible-playbook site.yml"
    ]
  }
}