# =====================
# 1. Security Groups
# =====================

resource "aws_security_group" "alb_sg" {
  name        = "${var.project_name}-ALB-SG"
  description = "Allow HTTP/HTTPS inbound traffic to ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from Internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from Internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-ALB-SG" }
}

resource "aws_security_group" "bastion_sg" {
  name        = "${var.project_name}-Bastion-SG"
  description = "Allow SSH to Bastion / Ansible Controller"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "SSH from Internet"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-Bastion-SG" }
}

resource "aws_security_group" "k8s_sg" {
  name        = "${var.project_name}-K8s-Cluster-SG"
  description = "Security group for Kubernetes Master and Workers"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "SSH from Bastion (Ansible)"
    from_port       = 22
    to_port         = 22
    protocol        = "tcp"
    security_groups = [aws_security_group.bastion_sg.id]
  }

  ingress {
    description     = "Kubernetes API from Bastion"
    from_port       = 6443
    to_port         = 6443
    protocol        = "tcp"
    security_groups = [aws_security_group.bastion_sg.id]
  }

  ingress {
    description = "All internal K8s traffic (CNI, etcd, Services, MongoDB, Observability)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  ingress {
    description     = "Gateway API NodePorts from ALB"
    from_port       = 30000
    to_port         = 32767
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-K8s-Cluster-SG" }
}

# =====================
# 2. SSH Key Pair
# =====================

resource "tls_private_key" "rsa_key" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "project_key" {
  key_name   = "${var.project_name}-key"
  public_key = tls_private_key.rsa_key.public_key_openssh
}

resource "local_file" "private_key" {
  content         = tls_private_key.rsa_key.private_key_pem
  filename        = "${path.module}/${var.project_name}-key.pem"
  file_permission = "0400"
}

# =====================
# 3. Ubuntu 22.04 AMI
# =====================

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

# =====================
# 4. EC2 Instances (Total = 7 vCPUs)
# =====================

# Bastion Host & Ansible Controller (1 vCPU)
resource "aws_instance" "bastion" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.bastion_instance_type
  subnet_id              = aws_subnet.public[0].id
  key_name               = aws_key_pair.project_key.key_name
  vpc_security_group_ids = [aws_security_group.bastion_sg.id]

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  user_data = <<-EOF
    #!/bin/bash
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y software-properties-common git jq curl python3-pip
    add-apt-repository --yes --update ppa:ansible/ansible
    apt-get install -y ansible

    mkdir -p /home/ubuntu/ansible /home/ubuntu/.ssh
    cat << 'SSHCFG' > /home/ubuntu/.ssh/config
    Host 10.0.*
      StrictHostKeyChecking no
      UserKnownHostsFile=/dev/null
    SSHCFG
    chmod 600 /home/ubuntu/.ssh/config
    chown -R ubuntu:ubuntu /home/ubuntu/ansible /home/ubuntu/.ssh
  EOF

  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "${var.project_name}-Bastion-Ansible-AZ-A"
    Role = "Bastion-Ansible"
  }
}

# Static Elastic IP for Bastion (persists across EC2 Stop/Start)
resource "aws_eip" "bastion_eip" {
  instance   = aws_instance.bastion.id
  domain     = "vpc"
  depends_on = [aws_internet_gateway.igw]

  tags = {
    Name = "${var.project_name}-Bastion-EIP"
  }
}

# Kubernetes Master Node (2 vCPUs)
resource "aws_instance" "k8s_master" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.k8s_instance_type
  subnet_id              = aws_subnet.private[0].id
  key_name               = aws_key_pair.project_key.key_name
  vpc_security_group_ids = [aws_security_group.k8s_sg.id]

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "${var.project_name}-K8s-Master-AZ-A"
    Role = "Master"
  }
}

# Kubernetes Worker Nodes (4 vCPUs total)
resource "aws_instance" "k8s_workers" {
  count                  = 2
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.k8s_instance_type
  subnet_id              = aws_subnet.private[count.index].id
  key_name               = aws_key_pair.project_key.key_name
  vpc_security_group_ids = [aws_security_group.k8s_sg.id]

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "${var.project_name}-K8s-Worker-${count.index + 1}-${var.azs[count.index]}"
    Role = "Worker"
  }
}

# =====================
# 5. Application Load Balancer (Routes to Gateway API NodePort)
# =====================

resource "aws_lb" "app_alb" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = aws_subnet.public[*].id

  tags = { Name = "${var.project_name}-ALB" }
}

resource "aws_lb_target_group" "gateway_http_tg" {
  name     = "${var.project_name}-gw-http-tg"
  port     = var.gateway_http_nodeport
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/"
    port                = "traffic-port"
    matcher             = "200-404"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.project_name}-Gateway-API-HTTP-TG" }
}

resource "aws_lb_target_group_attachment" "workers" {
  count            = length(aws_instance.k8s_workers)
  target_group_arn = aws_lb_target_group.gateway_http_tg.arn
  target_id        = aws_instance.k8s_workers[count.index].id
  port             = var.gateway_http_nodeport
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app_alb.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway_http_tg.arn
  }
}