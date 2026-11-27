output "alb_dns_name" {
  description = "Public DNS of the Application Load Balancer (Gateway API entry point)"
  value       = aws_lb.app_alb.dns_name
}

output "bastion_public_ip" {
  description = "Static Elastic IP of the Bastion / Ansible Controller"
  value       = aws_eip.bastion_eip.public_ip
}

output "bastion_ssh_command" {
  description = "Ready-to-use SSH command to connect to Bastion (fixed Elastic IP)"
  value       = "ssh -i ${var.project_name}-key.pem ubuntu@${aws_eip.bastion_eip.public_ip}"
}

output "nat_gateway_status" {
  description = "Current NAT Gateway Elastic IP or cost-saving disabled status"
  value       = length(aws_eip.nat_eip) > 0 ? aws_eip.nat_eip[0].public_ip : "DISABLED (Cost-Saving Mode)"
}

output "k8s_master_private_ip" {
  description = "Private IP of the Kubernetes Master Node"
  value       = aws_instance.k8s_master.private_ip
}

output "k8s_workers_private_ips" {
  description = "Private IPs of the Kubernetes Worker Nodes"
  value       = aws_instance.k8s_workers[*].private_ip
}